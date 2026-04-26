import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Trash2, Save, XCircle, ShoppingBag, MessageCircle, Download, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { useOrderStore } from '@/stores/orderStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { formatProductMultiLine } from '@/core/utils/product-format';
import { useOrderPaymentStore } from '@/stores/orderPaymentStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { vatEngine } from '@/core/tax/vat-engine';
import { usePermission } from '@/hooks/usePermission';
import type { Order, OrderStatus, TaxScheme } from '@/core/models/types';
import { ConfirmTaxSchemeModal } from '@/components/shared/ConfirmTaxSchemeModal';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';

function fmt(v: number | undefined | null): string {
  if (v === undefined || v === null) return '0';
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const STATUS_FLOW: OrderStatus[] = [
  'pending',
  'deposit_received',
  'sourcing',
  'sourced',
  'arrived',
  'notified',
  'completed',
];

function getNextStatus(current: OrderStatus): OrderStatus | null {
  const idx = STATUS_FLOW.indexOf(current);
  if (idx === -1 || idx >= STATUS_FLOW.length - 1) return null;
  return STATUS_FLOW[idx + 1];
}

function statusLabel(s: OrderStatus): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { orders, loadOrders, updateOrder, updateStatus, deleteOrder } = useOrderStore();
  const { categories, loadCategories } = useProductStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts } = useProductStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Order>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmAdvance, setConfirmAdvance] = useState<OrderStatus | null>(null);
  const [showMessage, setShowMessage] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);
  const [payMethod, setPayMethod] = useState('cash');
  const [payNote, setPayNote] = useState('');
  const [showInvoiceVatConfirm, setShowInvoiceVatConfirm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const { paymentsByOrder, loadPayments, addPayment, deletePayment } = useOrderPaymentStore();
  const { createDirectInvoice } = useInvoiceStore();
  const perm = usePermission();

  useEffect(() => { loadOrders(); loadCustomers(); loadProducts(); loadCategories(); }, [loadOrders, loadCustomers, loadProducts, loadCategories]);
  useEffect(() => { if (id) loadPayments(id); }, [id, loadPayments]);

  const payments = useMemo(() => (id ? paymentsByOrder[id] || [] : []), [id, paymentsByOrder]);
  const totalPaid = useMemo(() => payments.reduce((s, p) => s + p.amount, 0), [payments]);

  const order = useMemo(() => orders.find(o => o.id === id), [orders, id]);
  const customer = useMemo(
    () => order ? customers.find(c => c.id === order.customerId) : undefined,
    [order, customers],
  );
  const linkedProduct = useMemo(
    () => order?.productId ? products.find(p => p.id === order.productId) : undefined,
    [order, products],
  );

  useEffect(() => {
    if (order) setForm({ ...order });
  }, [order]);

  if (!order) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Order not found</p>
      </div>
    );
  }

  const nextStatus = getNextStatus(order.status);
  const isCancelled = order.status === 'cancelled';
  const isCompleted = order.status === 'completed';
  const remaining = (order.agreedPrice || 0) - totalPaid;
  const fullyPaid = (order.agreedPrice || 0) > 0 && totalPaid >= (order.agreedPrice || 0);

  function handleAddPayment() {
    if (!id) return;
    const amt = Number(payAmount);
    if (!amt || amt <= 0) { alert('Enter a valid amount.'); return; }
    addPayment({
      orderId: id,
      amount: amt,
      paidAt: payDate,
      method: payMethod,
      note: payNote || undefined,
    });
    setPayAmount(''); setPayNote(''); setPayDate(new Date().toISOString().split('T')[0]);
    setShowPayment(false);
  }

  function handleDownloadReceipt(p: { id: string; amount: number; paidAt: string; method?: string; reference?: string; note?: string }) {
    if (!order) return;
    // Plan §Print — Item-Beschreibung mit allen Specs (vom verknüpften Produkt oder Order-Attributen).
    const linkedProduct = order.existingProductId ? products.find(pp => pp.id === order.existingProductId) : undefined;
    const itemDesc = linkedProduct
      ? formatProductMultiLine(linkedProduct, categories)
      : (() => {
          const head = `${order.requestedBrand || ''} ${order.requestedModel || ''}`.trim();
          const cat = categories.find(c => c.id === order.categoryId);
          if (!cat) return head;
          const lines: string[] = [head];
          for (const attr of cat.attributes || []) {
            if (attr.key === 'description') continue;
            const v = (order.attributes as Record<string, unknown> | undefined)?.[attr.key];
            if (v === undefined || v === null || v === '') continue;
            const formatted = attr.type === 'boolean' ? (v ? 'Yes' : 'No')
              : Array.isArray(v) ? v.join(', ')
              : attr.unit ? `${v} ${attr.unit}` : String(v);
            lines.push(`${attr.label}: ${formatted}`);
          }
          return lines.join('\n');
        })();
    downloadPdf({
      title: `Payment Receipt \u2014 ${order.orderNumber}`,
      number: `${order.orderNumber}-${p.id.slice(0, 6).toUpperCase()}`,
      date: p.paidAt,
      subtitle: `Receipt for payment on order ${order.orderNumber}`,
      customer: customer ? { name: `${customer.firstName} ${customer.lastName}`, company: customer.company, phone: customer.phone } : undefined,
      type: 'receipt',
      sections: [
        { title: 'Order', lines: [
          { label: 'Order Number', value: order.orderNumber },
          { label: itemDesc, value: '' },
          ...(order.agreedPrice ? [{ label: 'Agreed Price', value: `${fmt(order.agreedPrice)} BHD` }] : []),
        ]},
        { title: 'Payment', lines: [
          { label: 'Amount Received', value: `${fmt(p.amount)} BHD`, bold: true },
          { label: 'Date', value: p.paidAt },
          ...(p.method ? [{ label: 'Method', value: p.method.replace('_', ' ') }] : []),
          ...(p.reference ? [{ label: 'Reference', value: p.reference }] : []),
          ...(p.note ? [{ label: 'Note', value: p.note }] : []),
        ]},
        { title: 'Balance', lines: [
          { label: 'Total Paid (incl. this)', value: `${fmt(totalPaid)} BHD` },
          ...(order.agreedPrice ? [{ label: 'Remaining', value: `${fmt(Math.max(0, order.agreedPrice - totalPaid))} BHD` }] : []),
        ]},
      ],
      footer: 'Thank you for your payment.',
    });
  }

  function handleSave() {
    if (!id) return;
    const margin =
      form.agreedPrice && form.supplierPrice
        ? form.agreedPrice - form.supplierPrice
        : undefined;
    const rem = (form.agreedPrice || 0) - (form.depositAmount || 0);
    updateOrder(id, {
      agreedPrice: form.agreedPrice,
      depositAmount: form.depositAmount,
      supplierName: form.supplierName,
      supplierPrice: form.supplierPrice,
      expectedMargin: margin,
      expectedDelivery: form.expectedDelivery,
      remainingAmount: rem,
      notes: form.notes,
    });
    setEditing(false);
  }

  function handleAdvance(status: OrderStatus) {
    if (!id) return;
    updateStatus(id, status);
    setConfirmAdvance(null);
  }

  function handleCancel() {
    if (!id) return;
    updateStatus(id, 'cancelled');
    setConfirmCancel(false);
  }

  function handleDelete() {
    if (!id) return;
    deleteOrder(id);
    navigate('/orders');
  }

  function handleCreateFinalInvoice() {
    if (!id || !order || !linkedProduct) return;
    const gross = order.agreedPrice || totalPaid;
    if (gross <= 0) { alert('Agreed price required.'); return; }
    setShowInvoiceVatConfirm(true);
  }

  async function handleConfirmFinalInvoice(perLine: Record<string, TaxScheme>) {
    setShowInvoiceVatConfirm(false);
    if (!id || !order || !linkedProduct) return;
    // `agreedPrice` ist der Netto-Verkaufspreis (Plan §Tax §7: System rechnet Gross auto).
    const agreedNet = order.agreedPrice || totalPaid;
    if (agreedNet <= 0) { alert('Agreed price required.'); return; }
    const taxScheme = (perLine[linkedProduct.id] || linkedProduct.taxScheme || 'MARGIN') as TaxScheme;
    const vatRate = 10;
    const calc = vatEngine.calculateNet(agreedNet, linkedProduct.purchasePrice || 0, taxScheme, vatRate);
    const invoice = createDirectInvoice(
      order.customerId,
      [{
        productId: linkedProduct.id,
        unitPrice: calc.netAmount,
        purchasePrice: linkedProduct.purchasePrice || 0,
        taxScheme,
        vatRate,
        vatAmount: calc.vatAmount,
        lineTotal: calc.grossAmount,
      }],
      `Final invoice for order ${order.orderNumber}`,
    );
    updateOrder(id, { invoiceId: invoice.id });
    // Carry over each order payment as a real invoice payment, preserving method
    const orderPayments = paymentsByOrder[id] || [];
    if (orderPayments.length > 0) {
      const inv = useInvoiceStore.getState();
      for (const op of orderPayments) {
        inv.recordPayment(invoice.id, op.amount, op.method || 'cash', `Carried over from order ${order.orderNumber}`);
      }
      // Flag order_payments as already converted, so cashflow doesn't double-count
      const { getDatabase: getDb, saveDatabase: saveDb } = await import('@/core/db/database');
      const db = getDb();
      db.run(`UPDATE order_payments SET converted_to_invoice = 1 WHERE order_id = ?`, [id]);
      await saveDb();
    } else if (totalPaid > 0) {
      useInvoiceStore.getState().recordPayment(invoice.id, totalPaid, 'cash', `Carried over from order ${order.orderNumber}`);
    }
    navigate(`/invoices/${invoice.id}`);
  }

  function renderField(label: string, value: React.ReactNode, editField?: React.ReactNode) {
    return (
      <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E1D6' }}>
        <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
        {editing && editField ? editField : <span style={{ fontSize: 13, color: '#0F0F10' }}>{value || '\u2014'}</span>}
      </div>
    );
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/orders')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Orders
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...order }); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                {(order.status === 'arrived' || order.status === 'sourced') && customer && (
                  <Button variant="secondary" onClick={() => setShowMessage(true)}>
                    <MessageCircle size={14} /> AI Notify Arrival
                  </Button>
                )}
                {!isCancelled && !isCompleted && perm.canManageOrders && (
                  <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>
                )}
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                {!isCancelled && !isCompleted && perm.canManageOrders && (
                  <Button variant="danger" onClick={() => setConfirmCancel(true)}><XCircle size={14} /> Cancel Order</Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>
          {/* Icon / Order Visual */}
          <div className="rounded-xl flex items-center justify-center"
            style={{ height: 400, background: '#EFECE2', border: '1px solid #E5E1D6' }}>
            <ShoppingBag size={64} strokeWidth={0.8} style={{ color: '#6B7280' }} />
          </div>

          {/* Key Info */}
          <div>
            <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>{order.orderNumber}</span>
            <span className="text-overline">{order.requestedBrand}</span>
            <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>
              {order.requestedModel}
            </h1>
            {order.requestedReference && (
              <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 8 }}>{order.requestedReference}</span>
            )}
            {order.requestedDetails && (
              <p style={{ fontSize: 13, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>{order.requestedDetails}</p>
            )}

            <div className="flex items-center gap-4" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <StatusDot status={order.status} />
              {/* Kategorie-Badge wenn vorhanden */}
              {(() => {
                const cat = categories.find(c => c.id === order.categoryId);
                if (!cat) return null;
                return (
                  <span style={{
                    fontSize: 11, padding: '3px 12px', borderRadius: 999,
                    background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                  }}>{cat.name}</span>
                );
              })()}
              {order.condition && (
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, background: 'rgba(15,15,16,0.06)', color: '#0F0F10', border: '1px solid #D5D1C4' }}>
                  {order.condition}
                </span>
              )}
              {order.existingProductId && (
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, background: 'rgba(126,170,110,0.1)', color: '#5A8552', border: '1px solid rgba(126,170,110,0.3)' }}>
                  Existing Item
                </span>
              )}
            </div>

            {/* Kategorie-Attribute strukturiert anzeigen */}
            {order.categoryId && order.attributes && Object.keys(order.attributes).length > 0 && (() => {
              const cat = categories.find(c => c.id === order.categoryId);
              if (!cat) return null;
              const attrs = order.attributes as Record<string, string | number | boolean | string[]>;
              const visible = cat.attributes.filter(a => attrs[a.key] !== undefined && attrs[a.key] !== '' && attrs[a.key] !== null);
              if (visible.length === 0) return null;
              return (
                <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E1D6' }}>
                  <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>{cat.name.toUpperCase()} DETAILS</span>
                  {visible.map(attr => {
                    const val = attrs[attr.key];
                    const display = typeof val === 'boolean' ? (val ? 'Yes' : 'No')
                      : Array.isArray(val) ? val.join(', ')
                      : String(val);
                    return (
                      <div key={attr.key} className="flex justify-between" style={{ padding: '4px 0', fontSize: 12 }}>
                        <span style={{ color: '#6B7280' }}>{attr.label}</span>
                        <span style={{ color: '#0F0F10' }}>{display}{attr.unit ? ` ${attr.unit}` : ''}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {customer && (
              <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E1D6' }}>
                <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 4 }}>Customer</span>
                <span style={{ fontSize: 14, color: '#0F0F10' }}>{customer.firstName} {customer.lastName}</span>
                {customer.company && (
                  <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginTop: 2 }}>{customer.company}</span>
                )}
              </div>
            )}

            {/* Pricing Summary */}
            <div style={{ marginTop: 28, borderTop: '1px solid #E5E1D6', paddingTop: 20 }}>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">AGREED PRICE</span>
                <span className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}>{fmt(order.agreedPrice)} BHD</span>
              </div>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">TOTAL PAID</span>
                <span className="font-display" style={{ fontSize: 20, color: fullyPaid ? '#7EAA6E' : '#AA956E' }}>
                  {fmt(totalPaid)} BHD
                </span>
              </div>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">REMAINING</span>
                <span className="font-mono" style={{ fontSize: 16, color: remaining <= 0 ? '#7EAA6E' : '#4B5563' }}>{fmt(Math.max(0, remaining))} BHD</span>
              </div>
            </div>

            {/* Status Advance */}
            {nextStatus && !isCancelled && !editing && perm.canManageOrders && (
              <div style={{ marginTop: 20 }}>
                <Button variant="primary" onClick={() => setConfirmAdvance(nextStatus)} fullWidth>
                  Advance to {statusLabel(nextStatus)}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Edit-Item-Card — Kategorie + Brand/Name + dynamische Attribute (nur im Edit) */}
        {editing && (
          <div style={{ marginBottom: 24 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>ITEM &amp; CATEGORY</span>

              {/* Category-Selector */}
              <div style={{ marginTop: 12 }}>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CATEGORY</span>
                <div className="flex flex-wrap gap-2">
                  {categories.map(cat => {
                    const active = form.categoryId === cat.id;
                    return (
                      <button key={cat.id} type="button" onClick={() => setForm({
                        ...form,
                        categoryId: cat.id,
                        condition: active ? form.condition : (cat.conditionOptions?.[0] || ''),
                        attributes: active ? form.attributes : {},
                      })}
                        className="cursor-pointer rounded-lg"
                        style={{
                          padding: '8px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                          border: `1px solid ${active ? cat.color : '#D5D1C4'}`,
                          color: active ? cat.color : '#6B7280',
                          background: active ? cat.color + '08' : 'transparent',
                        }}>
                        <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                        {cat.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                <Input label="BRAND" value={form.requestedBrand || ''}
                  onChange={e => setForm({ ...form, requestedBrand: e.target.value })} />
                <Input label="NAME / MODEL" value={form.requestedModel || ''}
                  onChange={e => setForm({ ...form, requestedModel: e.target.value })} />
              </div>
              <div style={{ marginTop: 12 }}>
                <Input label="REFERENCE / SKU" value={form.requestedReference || ''}
                  onChange={e => setForm({ ...form, requestedReference: e.target.value })} />
              </div>

              {/* Dynamic Category Attributes */}
              {(() => {
                const cat = categories.find(c => c.id === form.categoryId);
                if (!cat || cat.attributes.length === 0) return null;
                const attrs = (form.attributes || {}) as Record<string, string | number | boolean | string[]>;
                function setAttr(k: string, v: string | number | boolean | string[]) {
                  setForm({ ...form, attributes: { ...attrs, [k]: v } });
                }
                return (
                  <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #E5E1D6' }}>
                    <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>{cat.name.toUpperCase()} DETAILS</span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8 }}>
                      {cat.attributes.map(attr => {
                        if (attr.type === 'select' && attr.options) {
                          return (
                            <div key={attr.key}>
                              <span className="text-overline" style={{ marginBottom: 6 }}>{attr.label.toUpperCase()}</span>
                              <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                                {attr.options.map(opt => (
                                  <button key={opt} type="button" onClick={() => setAttr(attr.key, opt)}
                                    className="cursor-pointer"
                                    style={{
                                      padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                      border: `1px solid ${attrs[attr.key] === opt ? '#0F0F10' : '#D5D1C4'}`,
                                      color: attrs[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                      background: attrs[attr.key] === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                                    }}>{opt}</button>
                                ))}
                              </div>
                            </div>
                          );
                        }
                        if (attr.type === 'boolean') {
                          return (
                            <div key={attr.key}>
                              <span className="text-overline" style={{ marginBottom: 6 }}>{attr.label.toUpperCase()}</span>
                              <div className="flex gap-2" style={{ marginTop: 6 }}>
                                {[true, false].map(v => (
                                  <button key={String(v)} type="button" onClick={() => setAttr(attr.key, v)}
                                    className="cursor-pointer rounded"
                                    style={{ padding: '6px 14px', fontSize: 12,
                                      border: `1px solid ${attrs[attr.key] === v ? '#0F0F10' : '#D5D1C4'}`,
                                      color: attrs[attr.key] === v ? '#0F0F10' : '#6B7280',
                                      background: attrs[attr.key] === v ? 'rgba(15,15,16,0.06)' : 'transparent',
                                    }}>{v ? 'Yes' : 'No'}</button>
                                ))}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <Input key={attr.key}
                            label={attr.label.toUpperCase() + (attr.unit ? ` (${attr.unit})` : '')}
                            type={attr.type === 'number' ? 'number' : 'text'}
                            value={String(attrs[attr.key] || '')}
                            onChange={e => setAttr(attr.key, attr.type === 'number' ? Number(e.target.value) : e.target.value)} />
                        );
                      })}
                    </div>
                    {cat.conditionOptions.length > 0 && (
                      <div style={{ marginTop: 14 }}>
                        <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CONDITION</span>
                        <div className="flex flex-wrap gap-2" style={{ marginTop: 6 }}>
                          {cat.conditionOptions.map(c => (
                            <button key={c} type="button" onClick={() => setForm({ ...form, condition: c })}
                              className="cursor-pointer rounded"
                              style={{ padding: '7px 14px', fontSize: 12,
                                border: `1px solid ${form.condition === c ? '#0F0F10' : '#D5D1C4'}`,
                                color: form.condition === c ? '#0F0F10' : '#6B7280',
                                background: form.condition === c ? 'rgba(15,15,16,0.06)' : 'transparent',
                              }}>{c}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </Card>
          </div>
        )}

        {/* Details Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Sourcing Card */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>SOURCING</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Input label="SUPPLIER NAME" value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} />
                  <Input label="SUPPLIER PRICE (BHD)" type="number" value={form.supplierPrice ?? ''} onChange={e => setForm({ ...form, supplierPrice: Number(e.target.value) || undefined })} />
                  <Input label="AGREED PRICE (BHD)" type="number" value={form.agreedPrice ?? ''} onChange={e => setForm({ ...form, agreedPrice: Number(e.target.value) || undefined })} />
                  <Input label="DEPOSIT AMOUNT (BHD)" type="number" value={form.depositAmount ?? ''} onChange={e => setForm({ ...form, depositAmount: Number(e.target.value) || 0 })} />
                </div>
              ) : (
                <>
                  {renderField('Supplier', order.supplierName)}
                  {renderField('Supplier Price', order.supplierPrice !== undefined ? `${fmt(order.supplierPrice)} BHD` : undefined)}
                  {renderField('Expected Margin', order.expectedMargin !== undefined
                    ? <span className="font-mono" style={{ color: (order.expectedMargin || 0) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>{fmt(order.expectedMargin)} BHD</span>
                    : undefined)}
                </>
              )}
            </div>
          </Card>

          {/* Delivery & Details Card */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>DELIVERY & DETAILS</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Input label="EXPECTED DELIVERY" type="date" value={form.expectedDelivery || ''} onChange={e => setForm({ ...form, expectedDelivery: e.target.value })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                    <textarea
                      value={form.notes || ''}
                      onChange={e => setForm({ ...form, notes: e.target.value })}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D1C4', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {renderField('Expected Delivery', order.expectedDelivery)}
                  {renderField('Actual Delivery', order.actualDelivery)}
                  {renderField('Deposit Date', order.depositDate)}
                  {renderField('Created', order.createdAt?.split('T')[0])}
                  {renderField('Updated', order.updatedAt?.split('T')[0])}
                  {order.notes && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{order.notes}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {editing && perm.canDeleteOrders && (
              <div className="flex gap-2" style={{ marginTop: 20 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Order
                </Button>
              </div>
            )}
          </Card>
        </div>

        {/* Payments Card */}
        {!editing && !isCancelled && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
                <span className="text-overline">PAYMENTS ({payments.length})</span>
                <Button variant="secondary" onClick={() => setShowPayment(true)}>
                  <Plus size={14} /> Add Payment
                </Button>
              </div>
              {payments.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6B7280', padding: '12px 0' }}>No payments recorded yet.</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto auto', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>DATE</span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>AMOUNT</span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>METHOD</span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>NOTE</span>
                  <span />
                  <span />
                  {payments.map(p => (
                    <div key={p.id} style={{ display: 'contents' }}>
                      <span style={{ fontSize: 13, color: '#0F0F10', paddingTop: 10, borderTop: '1px solid #E5E1D6' }}>{p.paidAt}</span>
                      <span className="font-mono" style={{ fontSize: 13, color: '#7EAA6E', paddingTop: 10, borderTop: '1px solid #E5E1D6' }}>{fmt(p.amount)} BHD</span>
                      <span style={{ fontSize: 13, color: '#4B5563', paddingTop: 10, borderTop: '1px solid #E5E1D6' }}>{p.method?.replace('_', ' ') || '\u2014'}</span>
                      <span style={{ fontSize: 12, color: '#6B7280', paddingTop: 10, borderTop: '1px solid #E5E1D6' }}>{p.note || '\u2014'}</span>
                      <button onClick={() => handleDownloadReceipt(p)}
                        className="cursor-pointer transition-colors" style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 12, paddingTop: 10, borderTop: '1px solid #E5E1D6', display: 'flex', alignItems: 'center', gap: 4 }}
                      ><Download size={12} /> PDF</button>
                      <button onClick={() => id && deletePayment(p.id, id)}
                        className="cursor-pointer transition-colors" style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 11, paddingTop: 10, borderTop: '1px solid #E5E1D6' }}
                      >Delete</button>
                    </div>
                  ))}
                </div>
              )}
              {fullyPaid && !order.invoiceId && (
                <div style={{ marginTop: 16, padding: '12px 14px', background: 'rgba(126,170,110,0.06)', borderRadius: 8, border: '1px solid rgba(126,170,110,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 13, color: '#7EAA6E' }}>
                    {linkedProduct
                      ? 'Fully paid. Ready to finalize with an invoice.'
                      : 'Fully paid, but no product linked to this order. Link a product (Edit) to generate the final invoice.'}
                  </span>
                  {linkedProduct && perm.canManageOrders && (
                    <Button variant="primary" onClick={handleCreateFinalInvoice}>Create Final Invoice</Button>
                  )}
                </div>
              )}
              {order.invoiceId && (
                <div style={{ marginTop: 16, padding: '10px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E1D6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: '#4B5563' }}>Final invoice generated.</span>
                  <Button variant="secondary" onClick={() => navigate(`/invoices/${order.invoiceId}`)}>View Invoice</Button>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Status Timeline */}
        {!editing && (
          <div style={{ marginTop: 32 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>STATUS TIMELINE</span>
              <div className="flex items-center gap-0" style={{ marginTop: 20, overflowX: 'auto' }}>
                {STATUS_FLOW.map((s, i) => {
                  const currentIdx = STATUS_FLOW.indexOf(order.status);
                  const isPast = i <= currentIdx;
                  const isCurrent = s === order.status;
                  return (
                    <div key={s} className="flex items-center" style={{ flex: 1 }}>
                      <div className="flex flex-col items-center" style={{ flex: 1 }}>
                        <div
                          className="rounded-full flex items-center justify-center"
                          style={{
                            width: isCurrent ? 28 : 20,
                            height: isCurrent ? 28 : 20,
                            background: isPast ? (isCurrent ? '#0F0F10' : 'rgba(15,15,16,0.15)') : '#E5E1D6',
                            border: `2px solid ${isPast ? '#0F0F10' : '#D5D1C4'}`,
                            transition: 'all 0.3s ease',
                          }}
                        >
                          {isPast && !isCurrent && (
                            <span style={{ fontSize: 10, color: '#0F0F10' }}>&#10003;</span>
                          )}
                        </div>
                        <span style={{
                          fontSize: 10,
                          color: isCurrent ? '#0F0F10' : isPast ? '#4B5563' : '#6B7280',
                          marginTop: 6,
                          textAlign: 'center',
                          fontWeight: isCurrent ? 600 : 400,
                          whiteSpace: 'nowrap',
                        }}>
                          {statusLabel(s)}
                        </span>
                      </div>
                      {i < STATUS_FLOW.length - 1 && (
                        <div style={{
                          height: 2,
                          flex: 1,
                          minWidth: 24,
                          background: i < currentIdx ? '#0F0F10' : '#E5E1D6',
                          marginTop: -16,
                        }} />
                      )}
                    </div>
                  );
                })}
              </div>
              {isCancelled && (
                <div className="flex items-center gap-2" style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(170,110,110,0.06)', borderRadius: 8, border: '1px solid rgba(170,110,110,0.15)' }}>
                  <StatusDot status="cancelled" />
                  <span style={{ fontSize: 13, color: '#AA6E6E' }}>This order has been cancelled</span>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {/* Add Payment Modal */}
      <Modal open={showPayment} onClose={() => setShowPayment(false)} title="Add Payment" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="AMOUNT (BHD)" type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} autoFocus />
            <Input label="PAYMENT DATE" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {['cash', 'bank_transfer', 'card', 'cheque'].map(m => (
                <button key={m} onClick={() => setPayMethod(m)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '6px 12px', fontSize: 12,
                    border: `1px solid ${payMethod === m ? '#0F0F10' : '#D5D1C4'}`,
                    color: payMethod === m ? '#0F0F10' : '#6B7280',
                    background: payMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</button>
              ))}
            </div>
          </div>
          <Input label="NOTE (optional)" value={payNote} onChange={e => setPayNote(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setShowPayment(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleAddPayment} disabled={!payAmount}>Save Payment</Button>
          </div>
        </div>
      </Modal>

      {customer && (
        <MessagePreviewModal
          open={showMessage}
          onClose={() => setShowMessage(false)}
          type="order_arrived"
          customerId={customer.id}
          customerName={`${customer.firstName} ${customer.lastName}`}
          customerPhone={customer.phone}
          customerWhatsapp={customer.whatsapp}
          productImage={linkedProduct?.images?.[0]}
          productLabel={`${order.requestedBrand} ${order.requestedModel}`.trim()}
          details={`Order ${order.orderNumber} has arrived.${remaining > 0 ? ` Remaining amount: ${remaining} BHD.` : ''}`}
          linkedEntityType="order"
          linkedEntityId={order.id}
        />
      )}

      {/* Confirm Status Advance Modal */}
      <Modal open={!!confirmAdvance} onClose={() => setConfirmAdvance(null)} title="Advance Status" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Advance order <strong style={{ color: '#0F0F10' }}>{order.orderNumber}</strong> to <strong style={{ color: '#0F0F10' }}>{confirmAdvance ? statusLabel(confirmAdvance) : ''}</strong>?
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmAdvance(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => confirmAdvance && handleAdvance(confirmAdvance)}>Confirm</Button>
        </div>
      </Modal>

      {/* Confirm Cancel Modal */}
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel Order" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Cancel order <strong style={{ color: '#0F0F10' }}>{order.orderNumber}</strong>? This will mark the order as cancelled.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Back</Button>
          <Button variant="danger" onClick={handleCancel}>Cancel Order</Button>
        </div>
      </Modal>

      {/* Confirm Delete Modal */}
      <ConfirmTaxSchemeModal
        open={showInvoiceVatConfirm}
        lines={linkedProduct ? [{
          id: linkedProduct.id,
          label: `${linkedProduct.brand} ${linkedProduct.name}`,
          currentScheme: (linkedProduct.taxScheme as TaxScheme) || 'MARGIN',
        }] : []}
        onCancel={() => setShowInvoiceVatConfirm(false)}
        onConfirm={handleConfirmFinalInvoice}
        title="Create Final Invoice"
      />

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Order" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete <strong style={{ color: '#0F0F10' }}>{order.orderNumber}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="orders"
        entityId={order.id}
        title={`History · ${order.orderNumber}`}
      />
    </div>
  );
}
