import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShoppingBag, FileText } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useOrderStore } from '@/stores/orderStore';
import { useOrderPaymentStore } from '@/stores/orderPaymentStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { query } from '@/core/db/helpers';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { OrderStatus, OrderPaymentStatus, OrderType } from '@/core/models/types';
import { deriveOrderPaymentStatus } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  arrived: 'Arrived',
  notified: 'Notified',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const ORDER_STATUS_STYLE: Record<OrderStatus, { fg: string; bg: string }> = {
  pending:   { fg: '#AA956E', bg: 'rgba(170,149,110,0.10)' },
  arrived:   { fg: '#0F0F10', bg: 'rgba(15,15,16,0.06)' },
  notified:  { fg: '#6E8AAA', bg: 'rgba(110,138,170,0.12)' },
  completed: { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
  cancelled: { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)' },
};

const PAYMENT_STATUS_LABELS: Record<OrderPaymentStatus, string> = {
  UNPAID: 'Unpaid',
  PARTIALLY_PAID: 'Partially Paid',
  PAID: 'Paid',
};

const PAYMENT_STATUS_STYLE: Record<OrderPaymentStatus, { fg: string; bg: string }> = {
  UNPAID:         { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  PARTIALLY_PAID: { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)' },
  PAID:           { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
};

const FILTER_STATUSES: (OrderStatus | '')[] = ['', 'pending', 'arrived', 'notified', 'completed', 'cancelled'];

// v0.3.0 — Order-Type Filter + Badge
const FILTER_TYPES: (OrderType | '')[] = ['', 'normal', 'custom', 'mixed'];
const TYPE_BADGE: Record<OrderType, { icon: string; label: string; fg: string; bg: string }> = {
  normal: { icon: '📦', label: 'Normal', fg: '#4B5563', bg: 'rgba(75,85,99,0.10)' },
  custom: { icon: '💎', label: 'Custom', fg: '#4F46E5', bg: 'rgba(99,102,241,0.10)' },
  mixed:  { icon: '🔀', label: 'Mixed',  fg: '#92400E', bg: 'rgba(217,119,6,0.10)' },
};

// Spalten: Date | Order# | Type | Client | Phone | Total | Paid | Remaining | Payment | Order Status | (Convert-Action)
const GRID_COLUMNS = 'minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,0.8fr) minmax(0,1.6fr) minmax(0,1.1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,1.4fr)';

export function OrderList() {
  const navigate = useNavigate();
  const { orders, loadOrders, getOrderIdsNeedingPurchase } = useOrderStore();
  const { addPayment } = useOrderPaymentStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { loadCategories, loadProducts, products } = useProductStore();
  const { customers, loadCustomers } = useCustomerStore();

  const [searchParams, setSearchParams] = useSearchParams();
  const [filterStatus, setFilterStatus] = useState<OrderStatus | ''>('');
  const [filterType, setFilterType] = useState<OrderType | ''>('');
  const [searchQuery, setSearchQuery] = useState('');

  // Pay-Modal — analog InvoiceList
  const [payOrderId, setPayOrderId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('cash');

  useEffect(() => { loadOrders(); loadCustomers(); loadCategories(); loadProducts(); loadInvoices(); }, [loadOrders, loadCustomers, loadCategories, loadProducts, loadInvoices]);

  // Lookup invoiceNumber per id fuer "Already converted"-Tooltip
  const invMap = useMemo(() => {
    const m = new Map<string, string>();
    invoices.forEach(i => m.set(i.id, i.invoiceNumber));
    return m;
  }, [invoices]);

  // Plan §Order: Single source of truth fuer paid-Betrag = SUM(order_payments).
  // OrderDetail rechnet aus den geladenen Payments — wir brauchen denselben Wert in der Liste.
  const paidByOrder = useMemo(() => {
    const m = new Map<string, number>();
    try {
      const rows = query(
        `SELECT order_id, COALESCE(SUM(amount), 0) AS t FROM order_payments GROUP BY order_id`
      );
      rows.forEach(r => m.set(r.order_id as string, Number(r.t || 0)));
    } catch { /* table might not exist on first load */ }
    return m;
  }, [orders]);

  // Pre-fill from URL — forward customer to /orders/new
  useEffect(() => {
    const customerParam = searchParams.get('customer');
    if (customerParam) {
      setSearchParams({}, { replace: true });
      navigate(`/orders/new?customer=${customerParam}`);
    }
  }, [searchParams, setSearchParams, navigate]);

  const custMap = useMemo(() => {
    const m = new Map<string, { name: string; phone?: string }>();
    customers.forEach(c => {
      const fullName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.company || '—';
      m.set(c.id, { name: fullName, phone: c.phone || c.whatsapp });
    });
    return m;
  }, [customers]);

  const filtered = useMemo(() => {
    let r = orders;
    if (filterStatus) r = r.filter(o => o.status === filterStatus);
    if (filterType) r = r.filter(o => (o.type || 'normal') === filterType);
    if (searchQuery) {
      r = r.filter(o => {
        const customer = customers.find(c => c.id === o.customerId);
        return matchesDeep(o, searchQuery, [customer, o.product]);
      });
    }
    return r;
  }, [orders, filterStatus, filterType, searchQuery, customers]);

  // v0.6.9 — Set der Order-IDs, die noch beim Supplier bestellt werden muessen.
  // products-Map als Argument — dieselbe Quelle wie das „Auf Lager"-Badge,
  // damit Sidebar/OrderList/OrderDetail nicht auseinanderlaufen.
  const needsOrderIds = useMemo(
    () => {
      const qtyMap = new Map(products.map(p => [p.id, p.quantity ?? 0]));
      return getOrderIdsNeedingPurchase(qtyMap);
    },
    [orders, products, getOrderIdsNeedingPurchase]
  );

  const activeCount = orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;

  function handlePay() {
    if (!payOrderId || payAmount <= 0) return;
    addPayment({
      orderId: payOrderId,
      amount: payAmount,
      paidAt: new Date().toISOString().split('T')[0],
      method: payMethod,
    });
    setPayOrderId(null);
    setPayAmount(0);
  }

  return (
    <PageLayout
      title="Orders"
      subtitle={`${orders.length} order${orders.length === 1 ? '' : 's'} · ${activeCount} open`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search by order #, brand, model, customer..."
      actions={
        <div className="flex items-center gap-3">
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {FILTER_TYPES.map(t => (
              <button key={t} onClick={() => setFilterType(t)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '5px 10px', fontSize: 11, borderRadius: 999, border: 'none',
                  background: filterType === t ? 'rgba(15,15,16,0.08)' : 'transparent',
                  color: filterType === t ? '#0F0F10' : '#6B7280',
                }}>{t === '' ? 'All types' : `${TYPE_BADGE[t].icon} ${TYPE_BADGE[t].label}`}</button>
            ))}
          </div>
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {FILTER_STATUSES.map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '5px 10px', fontSize: 11, borderRadius: 999, border: 'none',
                  background: filterStatus === s ? 'rgba(15,15,16,0.08)' : 'transparent',
                  color: filterStatus === s ? '#0F0F10' : '#6B7280',
                }}>{s === '' ? 'All' : ORDER_STATUS_LABELS[s]}</button>
            ))}
          </div>
          <Button variant="primary" onClick={() => navigate('/orders/new')}>New Order</Button>
        </div>
      }
    >
      {/* Spalten-Header — Plan §Order Übersicht: Date | # | Client | Phone | Total | Paid | Remaining | Payment | Order | Actions */}
      <div style={{ display: 'grid', gridTemplateColumns: GRID_COLUMNS, gap: 12, padding: '0 12px 10px' }}>
        {['DATE', 'ORDER #', 'TYPE', 'CLIENT', 'PHONE', 'TOTAL', 'PAID', 'REMAINING', 'PAYMENT', 'ORDER STATUS', 'ACTIONS'].map((h, i) => (
          <span key={i} className="text-overline">{h}</span>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <ShoppingBag size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {searchQuery || filterStatus ? 'No orders match your filters.' : 'No orders yet.'}
          </p>
        </div>
      )}

      {filtered.map(order => {
        const cust = custMap.get(order.customerId);
        const total = order.agreedPrice || 0;
        // Single source of truth: SUM(order_payments). Fallback auf deposit_amount falls
        // reconcile-cycle noch nicht durchgelaufen ist (z.B. unmittelbar nach createOrder).
        const paid = paidByOrder.get(order.id) ?? (order.depositAmount || 0);
        const remaining = Math.max(0, total - paid);
        const paymentStatus = deriveOrderPaymentStatus(total, paid);
        const orderStatus = order.status as OrderStatus;
        const payStyle = PAYMENT_STATUS_STYLE[paymentStatus];
        const ordStyle = ORDER_STATUS_STYLE[orderStatus] || ORDER_STATUS_STYLE.pending;
        const isOpenPayment = paymentStatus !== 'PAID' && orderStatus !== 'cancelled';

        return (
          <div key={order.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid', gridTemplateColumns: GRID_COLUMNS,
              gap: 12, padding: '14px 12px', alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => navigate(`/orders/${order.id}`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {/* Date */}
            <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtDate(order.createdAt)}
            </span>

            {/* Order Number + v0.6.9 Need-to-Order Indikator */}
            <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', minWidth: 0,
                                                  display: 'inline-flex', alignItems: 'center', gap: 8,
                                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {needsOrderIds.has(order.id) && (
                <span
                  className="pulse-orange"
                  title="Mind. ein Item ohne Bestand & noch nicht beim Supplier bestellt"
                  style={{
                    width: 9, height: 9, borderRadius: '50%',
                    background: '#D97706', flexShrink: 0,
                  }}
                />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{order.orderNumber}</span>
            </span>

            {/* v0.3.0 — Type-Badge */}
            {(() => {
              const tb = TYPE_BADGE[(order.type || 'normal') as OrderType];
              return (
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '3px 7px', borderRadius: 999,
                  color: tb.fg, background: tb.bg, justifySelf: 'start', whiteSpace: 'nowrap',
                }}>
                  {tb.icon} {tb.label}
                </span>
              );
            })()}

            {/* Client */}
            <span style={{ fontSize: 13, color: '#0F0F10', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cust?.name || '—'}
            </span>

            {/* Phone */}
            <span className="font-mono" style={{ fontSize: 12, color: '#4B5563', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cust?.phone || '—'}
            </span>

            {/* Total */}
            <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>
              {total > 0 ? <Bhd v={total}/> : '—'}
            </span>

            {/* Paid */}
            <span className="font-mono" style={{ fontSize: 13, color: paymentStatus === 'PAID' ? '#16A34A' : '#4B5563' }}>
              {paid > 0 ? <Bhd v={paid}/> : '—'}
            </span>

            {/* Remaining */}
            <span className="font-mono" style={{ fontSize: 13, color: remaining > 0.005 ? '#DC2626' : '#9CA3AF' }}>
              {remaining > 0.005 ? <Bhd v={remaining}/> : '—'}
            </span>

            {/* Payment Status + Pay Button */}
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span style={{
                padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                color: payStyle.fg, background: payStyle.bg,
                border: `1px solid ${payStyle.fg}33`, whiteSpace: 'nowrap',
              }}>
                {PAYMENT_STATUS_LABELS[paymentStatus]}
              </span>
              {isOpenPayment && total > 0 && (
                <button onClick={(e) => { e.stopPropagation(); setPayOrderId(order.id); setPayAmount(remaining); }}
                  className="cursor-pointer" style={{
                    padding: '3px 8px', fontSize: 10, border: '1px solid #16A34A',
                    color: '#16A34A', borderRadius: 4, background: 'none',
                  }}>Pay</button>
              )}
            </div>

            {/* Order Status */}
            <span style={{
              padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
              color: ordStyle.fg, background: ordStyle.bg,
              border: `1px solid ${ordStyle.fg}33`, whiteSpace: 'nowrap',
              justifySelf: 'start',
            }}>
              {ORDER_STATUS_LABELS[orderStatus] || orderStatus}
            </span>

            {/* Create-Invoice Action: nur bei completed.
                Wenn schon konvertiert → View-Invoice-Button. Design synchron zu
                TransferTable Create-Invoice (lila gefüllt) für Konsistenz. */}
            <div className="flex gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
              {order.invoiceId ? (
                <button
                  onClick={() => navigate(`/invoices/${order.invoiceId}`)}
                  title={`Already invoiced — ${invMap.get(order.invoiceId) || 'View Invoice'}`}
                  className="cursor-pointer flex items-center gap-1"
                  style={{
                    padding: '4px 10px', fontSize: 11, border: '1px solid #715DE3',
                    color: '#715DE3', borderRadius: 4, background: 'rgba(113,93,227,0.06)',
                  }}
                >
                  <FileText size={11} /> View Invoice
                </button>
              ) : orderStatus === 'completed' ? (
                <button
                  onClick={() => navigate(`/orders/${order.id}`)}
                  title="Create Invoice from this order"
                  className="cursor-pointer flex items-center gap-1"
                  style={{
                    padding: '4px 10px', fontSize: 11, border: '1px solid #715DE3',
                    color: '#FFFFFF', borderRadius: 4, background: '#715DE3', fontWeight: 500,
                  }}
                >
                  <FileText size={11} /> Create Invoice
                </button>
              ) : null}
            </div>
          </div>
        );
      })}

      {/* Pay-Modal */}
      <Modal open={!!payOrderId} onClose={() => setPayOrderId(null)} title="Record Payment" width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="AMOUNT (BHD)" type="number" value={payAmount || ''}
            onChange={e => setPayAmount(Number(e.target.value))} />
          <div>
            <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>METHOD</span>
            <select value={payMethod} onChange={e => setPayMethod(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF' }}>
              <option value="cash">Cash</option>
              <option value="bank">Bank Transfer</option>
              <option value="card">Card</option>
            </select>
          </div>
          <div className="flex gap-2 justify-end" style={{ marginTop: 8 }}>
            <Button variant="ghost" onClick={() => setPayOrderId(null)}>Cancel</Button>
            <Button variant="primary" onClick={handlePay}>Save Payment</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
