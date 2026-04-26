import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Phone, MessageCircle, Mail, Save, Trash2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { VIPBadge } from '@/components/ui/VIPBadge';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { useCustomerStore } from '@/stores/customerStore';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { usePermission } from '@/hooks/usePermission';
import { useProductStore } from '@/stores/productStore';
import { query } from '@/core/db/helpers';
import type { Customer, VIPLevel, SalesStage, CustomerType } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function CustomerActivity({ customerId, navigate }: { customerId: string; navigate: (path: string) => void }) {
  const activities = useMemo(() => {
    const items: { type: string; label: string; detail: string; date: string; amount?: number; status: string; link: string }[] = [];
    const dateOf = (iso: string | null | undefined) => (iso || '').split('T')[0];
    try {
      // Offers — create + sent events
      const offers = query(`SELECT id, offer_number, status, total, created_at, sent_at FROM offers WHERE customer_id = ? ORDER BY created_at DESC`, [customerId]);
      for (const o of offers) {
        items.push({ type: 'Offer', label: `${o.offer_number} created`, detail: `${fmt(o.total as number)} BHD`, date: dateOf(o.created_at as string), amount: o.total as number, status: o.status as string, link: `/offers/${o.id}` });
        if (o.sent_at) {
          items.push({ type: 'Offer', label: `${o.offer_number} sent`, detail: `${fmt(o.total as number)} BHD`, date: dateOf(o.sent_at as string), status: 'sent', link: `/offers/${o.id}` });
        }
      }
      // Invoices — issue event
      const invoices = query(`SELECT id, invoice_number, status, gross_amount, created_at, issued_at, paid_amount FROM invoices WHERE customer_id = ? ORDER BY created_at DESC`, [customerId]);
      for (const i of invoices) {
        items.push({ type: 'Invoice', label: `${i.invoice_number} issued`, detail: `${fmt(i.gross_amount as number)} BHD`, date: dateOf((i.issued_at as string) || (i.created_at as string)), amount: i.gross_amount as number, status: i.status as string, link: `/invoices/${i.id}` });
      }
      // Repairs — received, diagnosed, completed, picked_up
      const repairs = query(`SELECT id, repair_number, status, charge_to_customer, received_at, diagnosed_at, started_at, completed_at, picked_up_at FROM repairs WHERE customer_id = ? ORDER BY received_at DESC`, [customerId]);
      for (const r of repairs) {
        const priceDetail = r.charge_to_customer ? `${fmt(r.charge_to_customer as number)} BHD` : '';
        const num = r.repair_number as string;
        const link = `/repairs/${r.id}`;
        items.push({ type: 'Repair', label: `${num} received`, detail: priceDetail, date: dateOf(r.received_at as string), status: 'received', link });
        if (r.diagnosed_at) items.push({ type: 'Repair', label: `${num} diagnosed`, detail: priceDetail, date: dateOf(r.diagnosed_at as string), status: 'diagnosed', link });
        if (r.started_at) items.push({ type: 'Repair', label: `${num} started`, detail: priceDetail, date: dateOf(r.started_at as string), status: 'in_progress', link });
        if (r.completed_at) items.push({ type: 'Repair', label: `${num} ready`, detail: priceDetail, date: dateOf(r.completed_at as string), status: 'ready', link });
        if (r.picked_up_at) items.push({ type: 'Repair', label: `${num} picked up`, detail: priceDetail, date: dateOf(r.picked_up_at as string), status: 'picked_up', link });
      }
      // Consignments
      const consignments = query(`SELECT id, consignment_number, status, agreed_price, sale_price, created_at FROM consignments WHERE consignor_id = ? ORDER BY created_at DESC`, [customerId]);
      for (const c of consignments) {
        items.push({ type: 'Consignment', label: c.consignment_number as string, detail: `${fmt(c.agreed_price as number)} BHD`, date: dateOf(c.created_at as string), status: c.status as string, link: `/consignments/${c.id}` });
      }
      // Orders — created, deposit, arrived
      const orders = query(`SELECT id, order_number, status, agreed_price, created_at, deposit_date, actual_delivery FROM orders WHERE customer_id = ? ORDER BY created_at DESC`, [customerId]);
      for (const o of orders) {
        const priceDetail = o.agreed_price ? `${fmt(o.agreed_price as number)} BHD` : '';
        const num = o.order_number as string;
        const link = `/orders/${o.id}`;
        items.push({ type: 'Order', label: `${num} created`, detail: priceDetail, date: dateOf(o.created_at as string), status: 'pending', link });
        if (o.deposit_date) items.push({ type: 'Order', label: `${num} deposit received`, detail: priceDetail, date: o.deposit_date as string, status: 'deposit_received', link });
        if (o.actual_delivery) items.push({ type: 'Order', label: `${num} arrived`, detail: priceDetail, date: o.actual_delivery as string, status: 'arrived', link });
      }
      // Order payments — one entry per partial payment
      const payments = query(
        `SELECT op.id, op.amount, op.paid_at, op.method, op.note, o.order_number, o.id as order_id
         FROM order_payments op JOIN orders o ON o.id = op.order_id
         WHERE o.customer_id = ? ORDER BY op.paid_at DESC`,
        [customerId]
      );
      for (const p of payments) {
        const method = (p.method as string | null)?.replace('_', ' ') || '';
        const detail = `${fmt(p.amount as number)} BHD${method ? ` \u00b7 ${method}` : ''}`;
        items.push({
          type: 'Payment',
          label: `${p.order_number} \u2014 payment`,
          detail,
          date: p.paid_at as string,
          status: 'paid',
          link: `/orders/${p.order_id}`,
        });
      }
      // Tasks
      const tasks = query(`SELECT id, title, status, priority, due_at, created_at FROM tasks WHERE linked_entity_type = 'customer' AND linked_entity_id = ? AND status != 'completed' AND status != 'cancelled' ORDER BY due_at ASC LIMIT 5`, [customerId]);
      for (const t of tasks) {
        items.push({ type: 'Task', label: t.title as string, detail: t.priority as string, date: dateOf((t.due_at as string) || (t.created_at as string)), status: t.status as string, link: `/tasks` });
      }
      // Messages (AI/WhatsApp/other outbound)
      try {
        const messages = query(`SELECT id, channel, kind, body, sent_at FROM customer_messages WHERE customer_id = ? ORDER BY sent_at DESC LIMIT 20`, [customerId]);
        for (const m of messages) {
          const channel = (m.channel as string)?.replace('_', ' ') || 'message';
          const kind = (m.kind as string | null)?.replace('_', ' ') || 'message';
          const body = (m.body as string) || '';
          items.push({
            type: 'Message',
            label: `${kind} via ${channel}`,
            detail: body.length > 60 ? `${body.slice(0, 60)}\u2026` : body,
            date: dateOf(m.sent_at as string),
            status: 'sent',
            link: `/customers/${customerId}`,
          });
        }
      } catch { /* table missing on old DB */ }
    } catch { /* not authenticated yet */ }
    return items.sort((a, b) => b.date.localeCompare(a.date));
  }, [customerId]);

  if (activities.length === 0) {
    return <p style={{ fontSize: 13, color: '#6B7280', marginTop: 16 }}>No activity yet.</p>;
  }

  const typeColors: Record<string, string> = {
    Offer: '#6E8AAA', Invoice: '#0F0F10', Repair: '#AA956E', Consignment: '#A76ECF', Order: '#7EAA6E', Task: '#AA956E', Payment: '#7EAA6E', Message: '#6E8AAA',
  };

  return (
    <div style={{ marginTop: 16 }}>
      {activities.map((a, i) => (
        <div key={`${a.type}-${a.label}-${i}`}
          className="flex items-center justify-between cursor-pointer rounded transition-colors"
          style={{ padding: '10px 8px', margin: '0 -8px', borderBottom: '1px solid rgba(15,15,16,0.03)' }}
          onClick={() => navigate(a.link)}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(229,225,214,0.6)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <div className="flex items-center gap-3">
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: (typeColors[a.type] || '#6B7280') + '15', color: typeColors[a.type] || '#6B7280', border: `1px solid ${(typeColors[a.type] || '#6B7280')}30` }}>
              {a.type}
            </span>
            <div>
              <span className="font-mono" style={{ fontSize: 12, color: '#4B5563' }}>{a.label}</span>
              <StatusDot status={a.status} />
            </div>
          </div>
          <div className="text-right">
            {a.detail && <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{a.detail}</span>}
            <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>{a.date}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const BRANDS = ['Rolex', 'Patek Philippe', 'Audemars Piguet', 'Richard Mille', 'Cartier', 'Hermes', 'Chanel', 'Van Cleef & Arpels', 'Louis Vuitton', 'Chrome Hearts', 'Vacheron Constantin', 'A. Lange & Sohne'];
const STAGES: { value: SalesStage; label: string }[] = [
  { value: 'lead', label: 'Lead' }, { value: 'qualified', label: 'Qualified' },
  { value: 'active', label: 'Active' }, { value: 'dormant', label: 'Dormant' }, { value: 'lost', label: 'Lost' },
];
const TYPES: { value: CustomerType; label: string }[] = [
  { value: 'collector', label: 'Collector' }, { value: 'dealer', label: 'Dealer' },
  { value: 'investor', label: 'Investor' }, { value: 'gift_buyer', label: 'Gift Buyer' },
];

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { customers, loadCustomers, updateCustomer, deleteCustomer, getCustomerStats } = useCustomerStore();
  const { loadReturns: loadSalesReturns, getCustomerRefundPayable } = useSalesReturnStore();
  const { products, loadProducts } = useProductStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Customer>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const perm = usePermission();

  useEffect(() => { loadCustomers(); loadProducts(); loadSalesReturns(); }, [loadCustomers, loadProducts, loadSalesReturns]);

  const customer = useMemo(() => customers.find(c => c.id === id), [customers, id]);

  useEffect(() => {
    if (customer) setForm({ ...customer });
  }, [customer]);

  const matchingProducts = useMemo(() => {
    if (!customer) return [];
    return products
      .filter(p => p.stockStatus === 'in_stock')
      .filter(p => {
        const brandMatch = customer.preferences.length === 0 || customer.preferences.includes(p.brand);
        const budgetMatch = !customer.budgetMax || (p.plannedSalePrice || p.purchasePrice) <= customer.budgetMax;
        return brandMatch && budgetMatch;
      })
      .slice(0, 6);
  }, [customer, products]);

  if (!customer) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Client not found</p>
      </div>
    );
  }

  function handleSave() {
    if (!id) return;
    updateCustomer(id, form);
    setEditing(false);
  }

  function handleDelete() {
    if (!id) return;
    deleteCustomer(id);
    navigate('/clients');
  }

  const initials = `${customer.firstName[0]}${customer.lastName[0]}`;

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/clients')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Clients
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...customer }); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                {perm.canEditCustomers && <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>}
                {(customer.whatsapp || customer.phone) && (
                  <Button variant="secondary" onClick={() => setShowMessage(true)}>
                    <Sparkles size={14} /> AI Message
                  </Button>
                )}
                {(customer.whatsapp || customer.phone) && (
                  <Button variant="ghost" onClick={() => {
                    const num = (customer.whatsapp || customer.phone || '').replace(/[^0-9+]/g, '').replace(/^\+/, '');
                    window.open(`https://wa.me/${num}`, '_blank');
                  }}><MessageCircle size={14} /> WhatsApp</Button>
                )}
                <Button variant="secondary" onClick={() => navigate(`/repairs?customer=${id}`)}>New Repair</Button>
                <Button variant="secondary" onClick={() => navigate(`/orders?customer=${id}`)}>New Order</Button>
                <Button variant="primary" onClick={() => navigate(`/offers?customer=${id}`)}>Create Offer</Button>
              </>
            )}
          </div>
        </div>

        {/* Profile Card */}
        <div className="animate-fade-in" style={{ background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12, padding: '36px 40px', marginBottom: 32 }}>
          <div className="flex items-start gap-6">
            <div className="flex items-center justify-center rounded-full shrink-0"
              style={{ width: 72, height: 72, background: '#E5E9EE', border: customer.vipLevel >= 2 ? '2px solid #0F0F10' : '1px solid #D5D9DE', fontSize: 22, color: '#4B5563', fontFamily: 'var(--font-display)' }}>
              {initials}
            </div>
            <div className="flex-1">
              {editing ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <Input label="FIRST NAME" value={form.firstName || ''} onChange={e => setForm({ ...form, firstName: e.target.value })} />
                  <Input label="LAST NAME" value={form.lastName || ''} onChange={e => setForm({ ...form, lastName: e.target.value })} />
                  <Input label="COMPANY" value={form.company || ''} onChange={e => setForm({ ...form, company: e.target.value })} />
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10' }}>{customer.firstName} {customer.lastName}</h1>
                    <VIPBadge level={customer.vipLevel} />
                  </div>
                  {customer.company && <p style={{ fontSize: 14, color: '#4B5563', marginTop: 4 }}>{customer.company}</p>}
                </>
              )}

              {/* Contact */}
              {editing ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 8 }}>
                    <Input label="PHONE" value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} />
                    <Input label="WHATSAPP" value={form.whatsapp || ''} onChange={e => setForm({ ...form, whatsapp: e.target.value })} />
                    <Input label="EMAIL" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                    <Input label="PERSONAL ID (CPR / PASSPORT)" placeholder="e.g. 900123456" value={form.personalId || ''} onChange={e => setForm({ ...form, personalId: e.target.value })} />
                    <Input label="VAT ACCOUNT NUMBER (optional)" placeholder="For NBR B2B export" value={form.vatAccountNumber || ''} onChange={e => setForm({ ...form, vatAccountNumber: e.target.value })} />
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-4 flex-wrap" style={{ marginTop: 12 }}>
                  {customer.phone && (
                    <a href={`tel:${customer.phone}`} className="flex items-center gap-2" style={{ fontSize: 13, color: '#6B7280', textDecoration: 'none' }}>
                      <Phone size={14} /> {customer.phone}
                    </a>
                  )}
                  {customer.whatsapp && (
                    <a href={`https://wa.me/${customer.whatsapp.replace(/[^0-9]/g, '')}`} target="_blank" className="flex items-center gap-2" style={{ fontSize: 13, color: '#6B7280', textDecoration: 'none' }}>
                      <MessageCircle size={14} /> WhatsApp
                    </a>
                  )}
                  {customer.email && (
                    <a href={`mailto:${customer.email}`} className="flex items-center gap-2" style={{ fontSize: 13, color: '#6B7280', textDecoration: 'none' }}>
                      <Mail size={14} /> {customer.email}
                    </a>
                  )}
                  {customer.personalId && (
                    <span style={{ fontSize: 13, color: '#6B7280' }}>ID: {customer.personalId}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* KPIs — Live aus invoices berechnet (Definitionen vom Chef):
              Revenue = SUM(gross) ohne CANCELLED/DRAFT
              Profit  = SUM(margin_snapshot)
              Outstanding = SUM(gross − paid) bei PARTIAL/DRAFT */}
          {(() => {
            const stats = id ? getCustomerStats(id) : { revenue: 0, profit: 0, outstanding: 0, invoiceCount: 0, openInvoiceCount: 0 };
            const marginPct = stats.revenue > 0 ? (stats.profit / stats.revenue) * 100 : 0;
            const avgPerPurchase = stats.invoiceCount > 0 ? stats.revenue / stats.invoiceCount : 0;
            const refundPayable = id ? getCustomerRefundPayable(id) : 0;
            return editing ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginTop: 32 }}>
                <Input label="LAST PURCHASE DATE" type="date" value={form.lastPurchaseAt || ''} onChange={e => setForm({ ...form, lastPurchaseAt: e.target.value })} />
                <div style={{ padding: '12px 14px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                  <span className="text-overline" style={{ display: 'block', marginBottom: 4 }}>LIVE STATS (READ-ONLY)</span>
                  <div style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.6 }}>
                    Revenue {fmt(stats.revenue)} · Profit {fmt(stats.profit)} · Outstanding {fmt(stats.outstanding)} · Refund Payable {fmt(refundPayable)} BHD
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                    Werden automatisch aus Invoices + Returns berechnet — nicht editierbar.
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: refundPayable > 0 ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)', gap: 16, marginTop: 32 }}>
                {/* REVENUE — vertikal: Label oben, Wert mitte, Erklärung unten */}
                <div style={{ padding: '20px 22px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12 }}>
                  <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>REVENUE</span>
                  <div className="font-display" style={{ fontSize: 28, color: '#0F0F10', lineHeight: 1.1 }}>
                    {fmt(stats.revenue)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
                    Gesamtumsatz aus allen Rechnungen<br />
                    {stats.invoiceCount} invoice{stats.invoiceCount !== 1 ? 's' : ''} · Ø {fmt(avgPerPurchase)} BHD
                  </div>
                </div>

                {/* PROFIT — vertikal */}
                <div style={{ padding: '20px 22px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12 }}>
                  <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>PROFIT</span>
                  <div className="font-display" style={{ fontSize: 28, color: stats.profit >= 0 ? '#7EAA6E' : '#AA6E6E', lineHeight: 1.1 }}>
                    {fmt(stats.profit)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
                    Gesamtgewinn (Verkaufspreis − Kosten)<br />
                    {marginPct.toFixed(1)}% Marge
                  </div>
                </div>

                {/* OUTSTANDING — vertikal */}
                <div style={{ padding: '20px 22px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12 }}>
                  <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>OUTSTANDING</span>
                  <div className="font-display" style={{ fontSize: 28, color: stats.outstanding > 0 ? '#AA6E6E' : '#6B7280', lineHeight: 1.1 }}>
                    {fmt(stats.outstanding)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
                    Offener Betrag (Outstanding Balance)<br />
                    {stats.openInvoiceCount} open invoice{stats.openInvoiceCount !== 1 ? 's' : ''}
                  </div>
                </div>

                {/* REFUND PAYABLE — nur wenn > 0 */}
                {refundPayable > 0 && (
                  <div style={{ padding: '20px 22px', background: 'rgba(220,38,38,0.04)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 12 }}>
                    <span className="text-overline" style={{ display: 'block', marginBottom: 8, color: '#DC2626' }}>REFUND PAYABLE</span>
                    <div className="font-display" style={{ fontSize: 28, color: '#DC2626', lineHeight: 1.1 }}>
                      {fmt(refundPayable)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
                      Wir schulden dem Kunden noch (aus Returns).<br />
                      Customer Refund Payable
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Details */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 32 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>PROFILE</span>
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: editing ? 12 : 0 }}>
              {editing ? (
                <>
                  {/* Sales Stage */}
                  <div>
                    <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Sales Stage</span>
                    <div className="flex flex-wrap gap-1">
                      {STAGES.map(s => (
                        <button key={s.value} onClick={() => setForm({ ...form, salesStage: s.value })}
                          className="cursor-pointer" style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                            background: form.salesStage === s.value ? 'rgba(15,15,16,0.1)' : 'transparent',
                            color: form.salesStage === s.value ? '#0F0F10' : '#6B7280',
                          }}>{s.label}</button>
                      ))}
                    </div>
                  </div>
                  {/* Customer Type */}
                  <div>
                    <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Customer Type</span>
                    <div className="flex flex-wrap gap-1">
                      {TYPES.map(t => (
                        <button key={t.value} onClick={() => setForm({ ...form, customerType: t.value })}
                          className="cursor-pointer" style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                            background: form.customerType === t.value ? 'rgba(15,15,16,0.1)' : 'transparent',
                            color: form.customerType === t.value ? '#0F0F10' : '#6B7280',
                          }}>{t.label}</button>
                      ))}
                    </div>
                  </div>
                  {/* VIP */}
                  <div>
                    <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>VIP Level</span>
                    <div className="flex gap-1">
                      {([0, 1, 2, 3] as VIPLevel[]).map(l => (
                        <button key={l} onClick={() => setForm({ ...form, vipLevel: l })}
                          className="cursor-pointer" style={{
                            padding: '4px 12px', fontSize: 11, borderRadius: 4, border: 'none',
                            background: form.vipLevel === l ? 'rgba(15,15,16,0.1)' : 'transparent',
                            color: form.vipLevel === l ? '#0F0F10' : '#6B7280',
                          }}>{l === 0 ? 'Standard' : l === 1 ? 'VIP' : l === 2 ? 'VVIP' : 'Ultra'}</button>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Input label="COUNTRY" value={form.country || ''} onChange={e => setForm({ ...form, country: e.target.value })} />
                    <Input label="LANGUAGE" value={form.language || ''} onChange={e => setForm({ ...form, language: e.target.value })} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Input label="BUDGET MIN (BHD)" type="number" value={form.budgetMin || ''} onChange={e => setForm({ ...form, budgetMin: Number(e.target.value) || undefined })} />
                    <Input label="BUDGET MAX (BHD)" type="number" value={form.budgetMax || ''} onChange={e => setForm({ ...form, budgetMax: Number(e.target.value) || undefined })} />
                  </div>
                  {/* Preferences */}
                  <div>
                    <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Brand Preferences</span>
                    <div className="flex flex-wrap gap-1">
                      {BRANDS.map(brand => {
                        const sel = (form.preferences || []).includes(brand);
                        return (
                          <button key={brand}
                            onClick={() => {
                              const prefs = form.preferences || [];
                              setForm({ ...form, preferences: sel ? prefs.filter(p => p !== brand) : [...prefs, brand] });
                            }}
                            className="cursor-pointer" style={{
                              padding: '3px 8px', fontSize: 11, borderRadius: 999,
                              border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                              color: sel ? '#0F0F10' : '#6B7280',
                              background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{brand}</button>
                        );
                      })}
                    </div>
                  </div>
                  <Input label="LAST CONTACT" type="date" value={form.lastContactAt || ''} onChange={e => setForm({ ...form, lastContactAt: e.target.value })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                    <textarea value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })}
                      className="w-full outline-none" rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }} />
                  </div>
                  {perm.canDeleteCustomers && (
                    <Button variant="danger" onClick={() => setConfirmDelete(true)} style={{ marginTop: 8 }}>
                      <Trash2 size={14} /> Delete Client
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {[
                    { label: 'Status', value: <StatusDot status={customer.salesStage} /> },
                    { label: 'Type', value: customer.customerType.replace('_', ' ') },
                    { label: 'Country', value: customer.country },
                    { label: 'Language', value: customer.language },
                    { label: 'Budget', value: customer.budgetMin || customer.budgetMax ? `${fmt(customer.budgetMin || 0)} \u2013 ${fmt(customer.budgetMax || 0)} BHD` : null },
                    { label: 'Last Contact', value: customer.lastContactAt },
                    { label: 'Last Purchase', value: customer.lastPurchaseAt },
                  ].filter(i => i.value).map(item => (
                    <div key={item.label} className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
                      <span style={{ fontSize: 13, color: '#6B7280' }}>{item.label}</span>
                      <span style={{ fontSize: 13, color: '#0F0F10' }}>{item.value}</span>
                    </div>
                  ))}
                  {customer.preferences.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>Preferences</span>
                      <div className="flex flex-wrap gap-2">
                        {customer.preferences.map(p => (
                          <span key={p} style={{ padding: '4px 12px', fontSize: 11, borderRadius: 999, border: '1px solid #D5D9DE', color: '#0F0F10' }}>{p}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {customer.notes && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{customer.notes}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>

          {/* Activity: Offers, Invoices, Repairs, Consignments, Orders */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>ACTIVITY</span>
            <CustomerActivity customerId={id!} navigate={navigate} />
          </Card>
        </div>

        {/* Second Row: Matching Products */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 32 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>MATCHING ITEMS</span>
            {matchingProducts.length === 0 ? (
              <p style={{ fontSize: 13, color: '#6B7280', marginTop: 16 }}>No matching items found.</p>
            ) : (
              <div style={{ marginTop: 16 }}>
                {matchingProducts.map(p => (
                  <div key={p.id} className="flex items-center justify-between cursor-pointer rounded-md transition-colors"
                    style={{ padding: '10px 8px', margin: '0 -8px' }}
                    onClick={() => navigate(`/collection/${p.id}`)}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(26,26,31,0.6)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <div>
                      <span className="text-overline" style={{ fontSize: 10 }}>{p.brand}</span>
                      <div style={{ fontSize: 14, color: '#0F0F10', marginTop: 2 }}>{p.name}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(p.plannedSalePrice || p.purchasePrice)}</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>BHD</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* empty second column for grid balance */}
          <div />
        </div>
      </div>

      <MessagePreviewModal
        open={showMessage}
        onClose={() => setShowMessage(false)}
        type="follow_up"
        allowTypeChange
        customerId={customer.id}
        customerName={`${customer.firstName} ${customer.lastName}`}
        customerPhone={customer.phone}
        customerWhatsapp={customer.whatsapp}
      />

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Client" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete <strong style={{ color: '#0F0F10' }}>{customer.firstName} {customer.lastName}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>
    </div>
  );
}
