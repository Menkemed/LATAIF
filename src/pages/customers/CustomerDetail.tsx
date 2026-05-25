import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Edit3, Phone, MessageCircle, Mail, Save, Trash2, Sparkles,
  Receipt, FileMinus, Wallet, TrendingUp, BarChart3, Plus, Building2, CreditCard, Banknote, Smartphone, AlertTriangle,
} from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { VIPBadge } from '@/components/ui/VIPBadge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { validateCpr, validatePhone } from '@/core/contacts/contact-validate';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { useCustomerStore } from '@/stores/customerStore';
import { useGoldStore } from '@/stores/goldStore';
import { SettleGoldModal, type SettleGoldMode } from '@/components/repairs/SettleGoldModal';
import type { CustomerGoldCredit } from '@/core/models/types';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useDebtStore } from '@/stores/debtStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { usePermission } from '@/hooks/usePermission';
import { useProductStore } from '@/stores/productStore';
import { query } from '@/core/db/helpers';
import { Truck } from 'lucide-react';
import type { Customer, VIPLevel, SalesStage, CustomerType } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';

function fmtDate(iso?: string | null): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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

type PaymentEntry =
  | { type: 'payment'; id: string; amount: number; method: string; receivedAt: string; notes?: string; invoiceNumber: string; invoiceStatus: string; invoiceSpecialMark: boolean; invoiceId: string }
  | { type: 'refund'; id: string; amount: number; method: string; receivedAt: string; returnNumber: string; invoiceId: string; invoiceNumber: string; invoiceStatus: string; invoiceSpecialMark: boolean; creditNoteId?: string };

// Merged payment + refund history sorted by date descending.
function useCustomerPayments(customerId: string | undefined): PaymentEntry[] {
  return useMemo(() => {
    if (!customerId) return [];
    try {
      const payRows = query(
        `SELECT p.id, p.amount, p.method, p.received_at, p.notes, i.invoice_number, i.status, i.special_mark, i.id AS invoice_id
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
         WHERE i.customer_id = ?
         ORDER BY p.received_at DESC`,
        [customerId]
      );
      const payments: PaymentEntry[] = payRows.map(r => ({
        type: 'payment' as const,
        id: r.id as string,
        amount: r.amount as number,
        method: (r.method as string) || '',
        receivedAt: (r.received_at as string) || '',
        notes: (r.notes as string | null) || undefined,
        invoiceNumber: r.invoice_number as string,
        invoiceStatus: (r.status as string) || '',
        invoiceSpecialMark: Number(r.special_mark) === 1,
        invoiceId: r.invoice_id as string,
      }));

      const refundRows = query(
        `SELECT sr.id, sr.return_number, sr.refund_paid_amount, sr.refund_method,
                sr.refund_paid_date, sr.invoice_id, i.invoice_number, i.status, i.special_mark,
                cn.id AS cn_id
         FROM sales_returns sr
         JOIN invoices i ON i.id = sr.invoice_id
         LEFT JOIN credit_notes cn ON cn.sales_return_id = sr.id
         WHERE sr.customer_id = ? AND sr.refund_paid_amount > 0
         ORDER BY sr.refund_paid_date DESC`,
        [customerId]
      );
      const refunds: PaymentEntry[] = refundRows.map(r => ({
        type: 'refund' as const,
        id: r.id as string,
        amount: (r.refund_paid_amount as number) || 0,
        method: (r.refund_method as string) || 'cash',
        receivedAt: (r.refund_paid_date as string) || '',
        returnNumber: r.return_number as string,
        invoiceId: r.invoice_id as string,
        invoiceNumber: r.invoice_number as string,
        invoiceStatus: (r.status as string) || '',
        invoiceSpecialMark: Number(r.special_mark) === 1,
        creditNoteId: (r.cn_id as string | null) || undefined,
      }));

      return [...payments, ...refunds].sort(
        (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      );
    } catch { return []; }
  }, [customerId]);
}

function MethodIcon({ method }: { method: string }) {
  const m = method.toLowerCase();
  if (m.includes('cash')) return <Banknote size={14} style={{ color: '#16A34A' }} />;
  if (m.includes('bank')) return <Building2 size={14} style={{ color: '#3D7FFF' }} />;
  if (m.includes('benefit')) return <Smartphone size={14} style={{ color: '#FF8730' }} />;
  if (m.includes('card')) return <CreditCard size={14} style={{ color: '#715DE3' }} />;
  return <Wallet size={14} style={{ color: '#6B7280' }} />;
}

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/clients');
  const { customers, loadCustomers, updateCustomer, deleteCustomer, getCustomerStats } = useCustomerStore();
  const { loadReturns: loadSalesReturns, getCustomerRefundPayable } = useSalesReturnStore();
  const { products, loadProducts } = useProductStore();
  const { debts, loadDebts } = useDebtStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  // v0.4.4 — KEIN useGoldStore() ohne Selector: das ganze Store-Objekt aendert
  // bei jeder Mutation seine Referenz. In einer useEffect-Dependency + loadAll()
  // im Effect → Endlos-Loop (CustomerDetail fror beim Oeffnen ein). Stabile
  // Selektoren — Actions sind referenz-stabil.
  const goldLoadAll = useGoldStore(s => s.loadAll);
  const getGoldCreditByCustomer = useGoldStore(s => s.getGoldCreditByCustomer);
  const getGoldCreditsByCustomer = useGoldStore(s => s.getGoldCreditsByCustomer);
  const allGoldCredits = useGoldStore(s => s.customerGoldCredits);
  // v0.7.12 — Cross-Link Customer ↔ Supplier: wenn der Customer parallel als
  // Supplier auch existiert (z.B. weil er Consignment-Ware verkauft hat),
  // zeigen wir hier seine Supplier-Sicht (was wir IHM schulden).
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  const [settleModal, setSettleModal] = useState<{ open: boolean; mode: SettleGoldMode; credit?: CustomerGoldCredit }>({ open: false, mode: 'return_customer' });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Customer>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [noteModal, setNoteModal] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const perm = usePermission();

  useEffect(() => {
    loadCustomers(); loadProducts(); loadSalesReturns(); loadDebts(); loadInvoices();
    loadSuppliers(); loadPurchases();
    goldLoadAll();
  }, [loadCustomers, loadProducts, loadSalesReturns, loadDebts, loadInvoices, loadSuppliers, loadPurchases, goldLoadAll]);

  const customer = useMemo(() => customers.find(c => c.id === id), [customers, id]);

  // v0.7.12 — Match auf Supplier-Mirror via Phone (primaer) + Name (Fallback).
  // Gleiche Logik wie findOrCreateSupplierForConsignor im consignmentStore.
  // Wenn gefunden → 'Also as Supplier' Card mit offenen Payables-Summe + Link.
  const linkedSupplier = useMemo(() => {
    if (!customer) return undefined;
    const norm = (s?: string) => (s || '').replace(/\s+/g, '').toLowerCase();
    const phoneA = norm(customer.phone);
    if (phoneA) {
      const byPhone = suppliers.find(s => norm(s.phone) === phoneA);
      if (byPhone) return byPhone;
    }
    const fullName = `${customer.firstName} ${customer.lastName}`.trim().toLowerCase();
    if (fullName) {
      return suppliers.find(s => (s.name || '').trim().toLowerCase() === fullName);
    }
    return undefined;
  }, [customer, suppliers]);

  // Offene Payables-Summe aus Purchases dieses Supplier-Mirrors.
  const linkedSupplierOutstanding = useMemo(() => {
    if (!linkedSupplier) return { amount: 0, openCount: 0 };
    const ours = purchases.filter(p =>
      p.supplierId === linkedSupplier.id &&
      p.status !== 'PAID' && p.status !== 'CANCELLED'
    );
    return {
      amount: ours.reduce((s, p) => s + (p.remainingAmount || 0), 0),
      openCount: ours.length,
    };
  }, [linkedSupplier, purchases]);

  // Plan repair-multi-supplier — Gold-Credits dieses Kunden
  const goldCreditSummary = useMemo(() => id ? getGoldCreditByCustomer(id) : [], [id, getGoldCreditByCustomer, allGoldCredits]);
  const customerGoldCredits = useMemo(() => id ? getGoldCreditsByCustomer(id) : [], [id, getGoldCreditsByCustomer, allGoldCredits]);

  useEffect(() => {
    if (customer) setForm({ ...customer });
  }, [customer]);

  const customerInvoices = useMemo(
    () => id ? invoices.filter(i => i.customerId === id).sort((a, b) => (b.issuedAt || b.createdAt).localeCompare(a.issuedAt || a.createdAt)) : [],
    [invoices, id]
  );
  const customerLoans = useMemo(() => id ? debts.filter(d => d.customerId === id) : [], [debts, id]);
  const customerPayments = useCustomerPayments(id);

  // CN receivable_cancel per invoice — für korrekte "Remaining" Anzeige in der Invoice-Tabelle.
  const invoiceCNCancelMap = useMemo(() => {
    if (!customerInvoices.length) return {} as Record<string, number>;
    try {
      const ids = customerInvoices.map(i => i.id);
      const rows = query(
        `SELECT invoice_id, COALESCE(SUM(receivable_cancel_amount), 0) AS cancel_amount
         FROM credit_notes WHERE invoice_id IN (${ids.map(() => '?').join(',')})
         GROUP BY invoice_id`,
        ids
      );
      const map: Record<string, number> = {};
      for (const r of rows) map[r.invoice_id as string] = Number(r.cancel_amount || 0);
      return map;
    } catch { return {}; }
  }, [customerInvoices]);

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
    const errs: Record<string, string> = {};
    if (!form.firstName?.trim()) errs.firstName = 'Required';
    if (!form.lastName?.trim()) errs.lastName = 'Required';
    setEditErrors(errs);
    if (Object.keys(errs).length > 0) {
      setTimeout(() => {
        const firstKey = Object.keys(errs)[0];
        const el = document.getElementById(`field-${firstKey}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
      return;
    }
    updateCustomer(id, form);
    setEditErrors({});
    setEditing(false);
  }

  function handleDelete() {
    if (!id) return;
    deleteCustomer(id);
    navigate('/clients');
  }

  const initials = `${(customer.firstName || '').charAt(0)}${(customer.lastName || '').charAt(0)}`.toUpperCase() || '?';
  const stats = id ? getCustomerStats(id) : { revenue: 0, profit: 0, outstanding: 0, invoiceOutstanding: 0, loanOutstanding: 0, invoiceCount: 0, openInvoiceCount: 0, openLoanCount: 0, openTransferCount: 0 };
  const refundPayable = id ? getCustomerRefundPayable(id) : 0;
  const marginPct = stats.revenue > 0 ? (stats.profit / stats.revenue) * 100 : 0;
  const lastOrderInvoice = customerInvoices[0];

  // Status pill color for sales stage
  const stageColors: Record<string, { fg: string; bg: string }> = {
    active:    { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
    qualified: { fg: '#3D7FFF', bg: 'rgba(61,127,255,0.10)' },
    lead:      { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)' },
    dormant:   { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)' },
    lost:      { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  };
  const stageColor = stageColors[customer.salesStage] || stageColors.dormant;

  // Invoice status pill — netRemaining and cnCancel already account for CN receivable_cancel.
  function invoiceStatusPill(inv: typeof customerInvoices[number], netRemaining: number, cnCancel: number) {
    let label: string, fg: string, bg: string;
    if (inv.status === 'CANCELLED') { label = 'Cancelled'; fg = '#6B7280'; bg = 'rgba(107,114,128,0.10)'; }
    else if (inv.status === 'RETURNED') { label = 'Refunded'; fg = '#715DE3'; bg = 'rgba(113,93,227,0.10)'; }
    else if (inv.status === 'DRAFT') { label = 'Draft'; fg = '#6B7280'; bg = 'rgba(107,114,128,0.10)'; }
    else if (netRemaining <= 0.01 && cnCancel > 0.01) { label = 'Refunded'; fg = '#715DE3'; bg = 'rgba(113,93,227,0.10)'; }
    else if (netRemaining <= 0.01) { label = 'Paid'; fg = '#16A34A'; bg = 'rgba(22,163,74,0.10)'; }
    else if (inv.paidAmount > 0) { label = 'Partial'; fg = '#FF8730'; bg = 'rgba(255,135,48,0.10)'; }
    else { label = 'Unpaid'; fg = '#DC2626'; bg = 'rgba(220,38,38,0.08)'; }
    return (
      <span style={{
        padding: '3px 10px', fontSize: 11, borderRadius: 999, fontWeight: 500,
        color: fg, background: bg, border: `1px solid ${fg}30`,
      }}>{label}</span>
    );
  }

  // —— Helper: KPI Card with right-side icon
  function KpiCard({ label, value, hint, icon, iconBg, valueColor }:
    { label: string; value: number; hint?: string; icon: React.ReactNode; iconBg: string; valueColor?: string }) {
    return (
      <Card>
        <div className="flex items-start justify-between" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
          <div className="flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: 8, background: iconBg }}>
            {icon}
          </div>
        </div>
        <div className="font-display" style={{ fontSize: 26, color: valueColor || '#0F0F10', lineHeight: 1.1, marginTop: 4 }}>
          <Bhd v={value}/> <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
        </div>
        {hint && <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>{hint}</div>}
      </Card>
    );
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>

        {/* Header — Back + Action Buttons */}
        <div className="flex items-center justify-between" style={{ marginBottom: 24 }}>
          <button onClick={goBack}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}>
            <ArrowLeft size={16} /> Back
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...customer }); setEditErrors({}); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                {perm.canEditCustomers && <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit Client</Button>}
                {(customer.whatsapp || customer.phone) && (
                  <Button variant="secondary" onClick={() => setShowMessage(true)}><Sparkles size={14} /> AI Message</Button>
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

        {/* TOP PROFILE CARD */}
        {!editing ? (
          <Card>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 32, alignItems: 'center' }}>
              {/* Left: avatar + name + status + contact */}
              <div className="flex items-start gap-5" style={{ minWidth: 0 }}>
                <div className="flex items-center justify-center rounded-full shrink-0"
                  style={{ width: 88, height: 88, background: 'rgba(22,163,74,0.10)', border: customer.vipLevel >= 2 ? '2px solid #0F0F10' : '1px solid #D5D9DE', fontSize: 28, color: '#16A34A', fontFamily: 'var(--font-display)' }}>
                  {initials}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
                    <h1 className="font-display" style={{ fontSize: 26, color: '#0F0F10', lineHeight: 1.1 }}>{customer.firstName} {customer.lastName}</h1>
                    <VIPBadge level={customer.vipLevel} />
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <span style={{ padding: '2px 10px', fontSize: 11, borderRadius: 999, color: stageColor.fg, background: stageColor.bg }}>
                      {'\u25CF'} {customer.salesStage.charAt(0).toUpperCase() + customer.salesStage.slice(1)}
                    </span>
                  </div>
                  <div className="flex flex-col" style={{ marginTop: 14, gap: 6 }}>
                    {customer.phone && (
                      <a href={`tel:${customer.phone}`} className="flex items-center gap-2" style={{ fontSize: 13, color: '#4B5563', textDecoration: 'none' }}>
                        <Phone size={14} style={{ color: '#6B7280' }} /> {customer.phone}
                      </a>
                    )}
                    {customer.email && (
                      <a href={`mailto:${customer.email}`} className="flex items-center gap-2" style={{ fontSize: 13, color: '#4B5563', textDecoration: 'none' }}>
                        <Mail size={14} style={{ color: '#6B7280' }} /> {customer.email}
                      </a>
                    )}
                    {customer.notes ? (
                      <div className="flex items-start gap-2" style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                        <Edit3 size={12} style={{ color: '#9CA3AF', marginTop: 2 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any }}>{customer.notes}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2" style={{ fontSize: 12, color: '#9CA3AF', marginTop: 2 }}>
                        <Edit3 size={12} /> No notes
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {/* Right: meta panel */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Client Since</span><span style={{ color: '#0F0F10' }}>{fmtDate(customer.createdAt)}</span></div>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Client Type</span><span style={{ color: '#0F0F10', textTransform: 'capitalize' }}>{customer.customerType.replace('_', ' ')}</span></div>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Total Orders</span><span style={{ color: '#0F0F10' }}>{stats.invoiceCount}</span></div>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Last Order</span><span style={{ color: '#0F0F10' }}>{fmtDate(lastOrderInvoice?.issuedAt || lastOrderInvoice?.createdAt) || '\u2014'}</span></div>
              </div>
            </div>
          </Card>
        ) : null}

        {/* v0.7.12 \u2014 Cross-Link: Also as Supplier. Sichtbar wenn der Customer
            parallel als Supplier existiert (typisch nach Consignment-Sale). Klick
            navigiert zur Supplier-Sicht damit man die A/P-Sicht behandeln kann. */}
        {!editing && linkedSupplier && (
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => navigate(`/suppliers/${linkedSupplier.id}`)}
              className="cursor-pointer w-full text-left"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 18px', borderRadius: 12,
                border: '1px solid rgba(113,93,227,0.30)',
                background: 'rgba(113,93,227,0.05)',
                gap: 16,
              }}
              title="Open the supplier view to manage what we owe this person"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'rgba(113,93,227,0.10)', color: '#715DE3',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Truck size={16} />
                </div>
                <div>
                  <div style={{ fontSize: 13, color: '#0F0F10', fontWeight: 500 }}>
                    Also as Supplier {'\u00b7'} {linkedSupplier.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                    {linkedSupplierOutstanding.openCount > 0
                      ? `We owe ${linkedSupplierOutstanding.openCount} unpaid amount${linkedSupplierOutstanding.openCount === 1 ? '' : 's'} (Consignor payouts, Workshop fees, etc.)`
                      : 'No outstanding payables to this person right now.'}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="font-mono" style={{ fontSize: 16, color: linkedSupplierOutstanding.amount > 0 ? '#DC2626' : '#6B7280', fontWeight: 600 }}>
                  <Bhd v={linkedSupplierOutstanding.amount}/> BHD
                </div>
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>open payables {'\u00b7'} click to open {'\u2197'}</div>
              </div>
            </button>
          </div>
        )}

        {editing ? (
          /* Edit Mode — full edit form */
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {Object.keys(editErrors).length > 0 && (
                <div style={{
                  padding: '12px 16px', borderRadius: 8,
                  background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.30)',
                  color: '#DC2626', fontSize: 13,
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      Please fill in {Object.keys(editErrors).length} required field{Object.keys(editErrors).length === 1 ? '' : 's'}:
                    </div>
                    <ul style={{ margin: '4px 0 0 18px', listStyle: 'disc' }}>
                      {Object.entries(editErrors).map(([key, msg]) => (
                        <li key={key}>
                          <button onClick={() => {
                            const el = document.getElementById(`field-${key}`);
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }} className="cursor-pointer"
                            style={{ background: 'none', border: 'none', color: '#DC2626', textDecoration: 'underline', padding: 0, fontSize: 13 }}>
                            {key === 'firstName' ? 'First Name' : key === 'lastName' ? 'Last Name' : key}
                          </button>
                          {' \u2014 '}{msg}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
                <div id="field-firstName">
                  <Input required label="FIRST NAME" value={form.firstName || ''} error={editErrors.firstName}
                    onChange={e => { setForm({ ...form, firstName: e.target.value }); if (editErrors.firstName) setEditErrors({ ...editErrors, firstName: '' }); }} />
                </div>
                <div id="field-lastName">
                  <Input required label="LAST NAME" value={form.lastName || ''} error={editErrors.lastName}
                    onChange={e => { setForm({ ...form, lastName: e.target.value }); if (editErrors.lastName) setEditErrors({ ...editErrors, lastName: '' }); }} />
                </div>
                <Input label="COMPANY" value={form.company || ''} onChange={e => setForm({ ...form, company: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
                <div>
                  <PhoneInput label="PHONE" value={form.phone || ''} onChange={v => setForm({ ...form, phone: v })} />
                  <SoftWarn warning={validatePhone(form.phone).warning} />
                </div>
                <div>
                  <PhoneInput label="WHATSAPP" value={form.whatsapp || ''} onChange={v => setForm({ ...form, whatsapp: v })} />
                  <SoftWarn warning={validatePhone(form.whatsapp).warning} />
                </div>
                <Input label="EMAIL" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
                <div>
                  <Input label="PERSONAL ID (CPR / PASSPORT)" placeholder="e.g. 900123456" value={form.personalId || ''} onChange={e => setForm({ ...form, personalId: e.target.value })} />
                  <SoftWarn warning={validateCpr(form.personalId).warning} />
                </div>
                <Input label="VAT ACCOUNT NUMBER (optional)" placeholder="For NBR B2B export" value={form.vatAccountNumber || ''} onChange={e => setForm({ ...form, vatAccountNumber: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
                <Input label="COUNTRY" value={form.country || ''} onChange={e => setForm({ ...form, country: e.target.value })} />
                <Input label="LANGUAGE" value={form.language || ''} onChange={e => setForm({ ...form, language: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
                <Input label="BUDGET MIN (BHD)" type="number" value={form.budgetMin || ''} onChange={e => setForm({ ...form, budgetMin: Number(e.target.value) || undefined })} />
                <Input label="BUDGET MAX (BHD)" type="number" value={form.budgetMax || ''} onChange={e => setForm({ ...form, budgetMax: Number(e.target.value) || undefined })} />
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>SALES STAGE</span>
                <div className="flex flex-wrap gap-1">
                  {STAGES.map(s => (
                    <button key={s.value} onClick={() => setForm({ ...form, salesStage: s.value })}
                      className="cursor-pointer" style={{
                        padding: '6px 12px', fontSize: 12, borderRadius: 6, border: 'none',
                        background: form.salesStage === s.value ? 'rgba(15,15,16,0.1)' : 'transparent',
                        color: form.salesStage === s.value ? '#0F0F10' : '#6B7280',
                      }}>{s.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>VIP LEVEL</span>
                <div className="flex gap-2">
                  {([0, 1, 2, 3] as VIPLevel[]).map(l => (
                    <button key={l} onClick={() => setForm({ ...form, vipLevel: l })}
                      className="cursor-pointer rounded transition-all" style={{
                        padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${form.vipLevel === l ? '#0F0F10' : '#D5D9DE'}`,
                        color: form.vipLevel === l ? '#0F0F10' : '#6B7280',
                        background: form.vipLevel === l ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{l === 0 ? 'Standard' : l === 1 ? 'VIP' : l === 2 ? 'VVIP' : 'Ultra'}</button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CUSTOMER TYPE</span>
                <div className="flex gap-2">
                  {TYPES.map(t => (
                    <button key={t.value} onClick={() => setForm({ ...form, customerType: t.value })}
                      className="cursor-pointer rounded" style={{
                        padding: '6px 12px', fontSize: 12,
                        border: `1px solid ${form.customerType === t.value ? '#0F0F10' : '#D5D9DE'}`,
                        color: form.customerType === t.value ? '#0F0F10' : '#6B7280',
                        background: form.customerType === t.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{t.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PREFERRED BRANDS</span>
                <div className="flex flex-wrap gap-1" style={{ marginTop: 4 }}>
                  {BRANDS.map(b => {
                    const active = (form.preferences || []).includes(b);
                    return (
                      <button key={b} onClick={() => {
                        const cur = form.preferences || [];
                        setForm({ ...form, preferences: active ? cur.filter(x => x !== b) : [...cur, b] });
                      }} className="cursor-pointer rounded" style={{
                        padding: '4px 10px', fontSize: 11,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{b}</button>
                    );
                  })}
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
                <textarea
                  value={form.notes || ''}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  rows={4}
                  className="w-full"
                  style={{ background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10', resize: 'vertical' }} />
              </div>
              {perm.canDeleteCustomers && (
                <div className="flex justify-start" style={{ marginTop: 12 }}>
                  <Button variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete Client</Button>
                </div>
              )}
            </div>
          </Card>
        ) : null}

        {!editing && (
          <>
            {/* RECEIVABLE ROW — 3 (or 4 with refund) cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: refundPayable > 0 ? 'repeat(4, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))',
              gap: 16, marginTop: 24,
            }}>
              <KpiCard label="Open Receivables" value={stats.invoiceOutstanding}
                hint={(() => {
                  const parts: string[] = [];
                  if (stats.openInvoiceCount > 0) parts.push(`${stats.openInvoiceCount} ${stats.openInvoiceCount === 1 ? 'invoice' : 'invoices'}`);
                  if (stats.openTransferCount > 0) parts.push(`${stats.openTransferCount} ${stats.openTransferCount === 1 ? 'approval sale' : 'approval sales'}`);
                  return parts.length > 0 ? parts.join(' · ') : 'No open items';
                })()}
                icon={<Receipt size={18} style={{ color: '#DC2626' }} />} iconBg="rgba(220,38,38,0.10)"
                valueColor={stats.invoiceOutstanding > 0 ? '#DC2626' : '#0F0F10'} />
              <KpiCard label="Loans / Other Receivable" value={stats.loanOutstanding}
                hint={`${stats.openLoanCount} ${stats.openLoanCount === 1 ? 'Loan' : 'Loans'}`}
                icon={<FileMinus size={18} style={{ color: '#FF8730' }} />} iconBg="rgba(255,135,48,0.10)"
                valueColor={stats.loanOutstanding > 0 ? '#FF8730' : '#0F0F10'} />
              <KpiCard label="Total Receivable" value={stats.outstanding}
                hint="Total Outstanding"
                icon={<Wallet size={18} style={{ color: '#3D7FFF' }} />} iconBg="rgba(61,127,255,0.10)"
                valueColor={stats.outstanding > 0 ? '#3D7FFF' : '#0F0F10'} />
              {refundPayable > 0 && (
                <KpiCard label="Refund Payable" value={refundPayable}
                  hint="We owe customer"
                  icon={<Wallet size={18} style={{ color: '#DC2626' }} />} iconBg="rgba(220,38,38,0.10)"
                  valueColor="#DC2626" />
              )}
            </div>

            {/* REVENUE / PROFIT ROW */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16, marginTop: 16 }}>
              <KpiCard label="Total Revenue" value={stats.revenue}
                hint="All time"
                icon={<BarChart3 size={18} style={{ color: '#16A34A' }} />} iconBg="rgba(22,163,74,0.10)" />
              <KpiCard label="Total Profit" value={stats.profit}
                hint={`${marginPct.toFixed(1)}% Margin`}
                icon={<TrendingUp size={18} style={{ color: '#16A34A' }} />} iconBg="rgba(22,163,74,0.10)"
                valueColor={stats.profit >= 0 ? '#0F0F10' : '#DC2626'} />
            </div>

            {/* INVOICES TABLE */}
            <div style={{ marginTop: 24 }}>
              <Card>
                <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: 17, fontWeight: 600, color: '#0F0F10' }}>Invoices</h3>
                  <button onClick={() => navigate(`/invoices?customer=${id}`)}
                    className="cursor-pointer transition-colors"
                    style={{ background: 'none', border: '1px solid #E5E9EE', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: '#0F0F10' }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E9EE')}>
                    View All Invoices
                  </button>
                </div>
                {customerInvoices.length === 0 ? (
                  <p style={{ fontSize: 13, color: '#6B7280' }}>No invoices yet.</p>
                ) : (
                  <>
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)',
                      gap: 12, padding: '0 0 10px', borderBottom: '1px solid #E5E9EE',
                      fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
                    }}>
                      <span>Date</span><span>Invoice #</span><span>Total Amount</span><span>Paid</span><span>Status</span><span style={{ textAlign: 'right' }}>Remaining</span>
                    </div>
                    {customerInvoices.slice(0, 5).map(inv => {
                      const cnCancel = invoiceCNCancelMap[inv.id] || 0;
                      const remaining = Math.max(0, inv.grossAmount - inv.paidAmount - cnCancel);
                      return (
                        <div key={inv.id} className="cursor-pointer transition-colors"
                          onClick={() => navigate(`/invoices/${inv.id}`)}
                          style={{
                            display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)',
                            gap: 12, padding: '14px 0', alignItems: 'center', borderBottom: '1px solid rgba(229,225,214,0.6)', fontSize: 13,
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.02)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <span style={{ color: '#4B5563' }}>{fmtDate(inv.issuedAt || inv.createdAt)}</span>
                          <span className="font-mono" style={{ color: '#3D7FFF' }}>{formatInvoiceDisplayShort(inv)}</span>
                          <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={inv.grossAmount}/> BHD</span>
                          <span className="font-mono" style={{ color: '#4B5563' }}><Bhd v={inv.paidAmount}/> BHD</span>
                          <span>{invoiceStatusPill(inv, remaining, cnCancel)}</span>
                          <span className="font-mono" style={{ textAlign: 'right', color: remaining > 0 ? '#DC2626' : '#16A34A' }}><Bhd v={remaining}/> BHD</span>
                        </div>
                      );
                    })}
                    <div style={{ fontSize: 11, color: '#6B7280', marginTop: 12 }}>
                      Showing {Math.min(5, customerInvoices.length)} of {customerInvoices.length} invoice{customerInvoices.length === 1 ? '' : 's'}
                    </div>
                  </>
                )}
              </Card>
            </div>

            {/* Gold-Credit (Plan repair-multi-supplier) — KPI + Liste der OPEN
                Customer-Gold-Credits. Bewusst SEPARAT von BHD-Receivables:
                Gold bleibt Gold, Geld bleibt Geld. */}
            {(goldCreditSummary.length > 0 || customerGoldCredits.length > 0) && (
              <div style={{ marginTop: 24 }}>
                <Card>
                  <div className="flex justify-between items-start" style={{ marginBottom: 14 }}>
                    <span className="text-overline">GOLD CREDIT · BY KARAT</span>
                    {goldCreditSummary.length > 0 && (
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        {goldCreditSummary.map(s => (
                          <div key={s.karat} style={{
                            padding: '6px 12px', borderRadius: 6,
                            background: 'rgba(198,163,109,0.08)',
                            border: '1px solid rgba(198,163,109,0.3)',
                          }}>
                            <span className="font-mono" style={{ fontSize: 16, color: '#0F0F10' }}>
                              {s.totalGrams.toFixed(3)}g
                            </span>
                            <span style={{ fontSize: 11, color: '#8A7548', marginLeft: 6 }}>{s.karat}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {customerGoldCredits.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No gold credits.</p>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.9fr 0.8fr 1fr 1fr 1.4fr', gap: 12, fontSize: 12 }}>
                      <span className="text-overline">DATE</span>
                      <span className="text-overline">REPAIR</span>
                      <span className="text-overline">KARAT</span>
                      <span className="text-overline" style={{ textAlign: 'right' }}>WEIGHT (g)</span>
                      <span className="text-overline" style={{ textAlign: 'right' }}>SETTLED (g)</span>
                      <span className="text-overline">ACTIONS</span>
                      {customerGoldCredits.map(gc => {
                        const remaining = Math.max(0, gc.weightGrams - gc.fulfilledGrams);
                        return (
                          <div key={gc.id} style={{ display: 'contents' }}>
                            <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(gc.createdAt)}</span>
                            <span className="font-mono" style={{ fontSize: 11, color: '#3D7FFF', padding: '8px 0', borderTop: '1px solid #E5E9EE', cursor: gc.sourceRepairId ? 'pointer' : 'default' }}
                              onClick={() => gc.sourceRepairId && navigate(`/repairs/${gc.sourceRepairId}`)}>
                              {gc.sourceRepairId ? gc.sourceRepairId.slice(0, 8) : '—'}
                            </span>
                            <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{gc.karat}</span>
                            <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{gc.weightGrams.toFixed(3)}</span>
                            <span className="font-mono" style={{ fontSize: 12, color: gc.status === 'FULFILLED' ? '#16A34A' : '#6B7280', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>
                              {gc.fulfilledGrams.toFixed(3)}
                            </span>
                            <div style={{ padding: '6px 0', borderTop: '1px solid #E5E9EE', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {gc.status === 'OPEN' && remaining > 0 && (
                                <>
                                  <button onClick={() => setSettleModal({ open: true, mode: 'return_customer', credit: gc })}
                                    style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #D5D9DE', borderRadius: 4, background: 'transparent', color: '#0F0F10', cursor: 'pointer' }}>
                                    Return gold
                                  </button>
                                  <button onClick={() => setSettleModal({ open: true, mode: 'convert_customer_money', credit: gc })}
                                    style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #C6A36D', borderRadius: 4, background: 'rgba(198,163,109,0.08)', color: '#8A7548', cursor: 'pointer' }}>
                                    → BHD
                                  </button>
                                </>
                              )}
                              {gc.status !== 'OPEN' && (
                                <span style={{ fontSize: 10, color: '#6B7280' }}>{gc.status}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>
              </div>
            )}

            {/* LOANS / CASH GIVEN TABLE — split nach direction (we_lend = unsere Forderung, we_borrow = unsere Schuld) */}
            {customerLoans.length > 0 && (() => {
              const lent = customerLoans.filter(d => d.direction === 'we_lend');
              const borrowed = customerLoans.filter(d => d.direction === 'we_borrow');
              const renderRow = (d: typeof customerLoans[number], variant: 'lent' | 'borrowed') => {
                const open = Math.max(0, d.amount - d.paidAmount);
                const colors = variant === 'lent'
                  ? { open: { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)' } }
                  : { open: { fg: '#3D7FFF', bg: 'rgba(61,127,255,0.10)' } };
                let label: string, fg: string, bg: string;
                if (open <= 0.01) { label = variant === 'lent' ? 'Repaid' : 'Settled'; fg = '#16A34A'; bg = 'rgba(22,163,74,0.10)'; }
                else if (d.paidAmount > 0) { label = 'Partial'; fg = colors.open.fg; bg = colors.open.bg; }
                else { label = 'Open'; fg = colors.open.fg; bg = colors.open.bg; }
                const defaultNote = variant === 'lent' ? 'Cash given to client' : 'Borrowed from client';
                return (
                  <div key={d.id} style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)',
                    gap: 12, padding: '14px 0', alignItems: 'center', borderBottom: '1px solid rgba(229,225,214,0.6)', fontSize: 13,
                  }}>
                    <span style={{ color: '#4B5563' }}>{fmtDate(d.createdAt)}</span>
                    <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={d.amount}/> BHD</span>
                    <span style={{ color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.notes || defaultNote}</span>
                    <span><span style={{ padding: '3px 12px', fontSize: 11, borderRadius: 999, color: fg, background: bg, border: `1px solid ${fg}30` }}>{label}</span></span>
                    <span style={{ color: '#6B7280' }}>{d.dueDate ? fmtDate(d.dueDate) : '\u2014'}</span>
                  </div>
                );
              };
              const renderHeader = () => (
                <div style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)',
                  gap: 12, padding: '0 0 10px', borderBottom: '1px solid #E5E9EE',
                  fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  <span>Date</span><span>Amount</span><span>Note</span><span>Status</span><span>Due Date (Optional)</span>
                </div>
              );
              return (
                <>
                  {lent.length > 0 && (
                    <div style={{ marginTop: 24 }}>
                      <Card>
                        <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
                          <div className="flex items-center gap-3">
                            <h3 style={{ fontSize: 17, fontWeight: 600, color: '#0F0F10' }}>Loans / Cash Given</h3>
                            <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 999, color: '#FF8730', background: 'rgba(255,135,48,0.10)', border: '1px solid rgba(255,135,48,0.30)' }}>
                              We Lent
                            </span>
                          </div>
                          <button onClick={() => navigate(`/debts?customer=${id}`)}
                            className="cursor-pointer transition-colors"
                            style={{ background: 'none', border: '1px solid #E5E9EE', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: '#0F0F10' }}
                            onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                            onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E9EE')}>
                            View All Loans
                          </button>
                        </div>
                        {renderHeader()}
                        {lent.slice(0, 5).map(d => renderRow(d, 'lent'))}
                        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 12 }}>
                          Showing {Math.min(5, lent.length)} of {lent.length} loan{lent.length === 1 ? '' : 's'} given
                        </div>
                      </Card>
                    </div>
                  )}
                  {borrowed.length > 0 && (
                    <div style={{ marginTop: 24 }}>
                      <Card>
                        <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
                          <div className="flex items-center gap-3">
                            <h3 style={{ fontSize: 17, fontWeight: 600, color: '#0F0F10' }}>Borrowings / Cash Received</h3>
                            <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 999, color: '#3D7FFF', background: 'rgba(61,127,255,0.10)', border: '1px solid rgba(61,127,255,0.30)' }}>
                              We Borrowed
                            </span>
                          </div>
                          <button onClick={() => navigate(`/debts?customer=${id}`)}
                            className="cursor-pointer transition-colors"
                            style={{ background: 'none', border: '1px solid #E5E9EE', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: '#0F0F10' }}
                            onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                            onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E9EE')}>
                            View All
                          </button>
                        </div>
                        {renderHeader()}
                        {borrowed.slice(0, 5).map(d => renderRow(d, 'borrowed'))}
                        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 12 }}>
                          Showing {Math.min(5, borrowed.length)} of {borrowed.length} entr{borrowed.length === 1 ? 'y' : 'ies'}
                        </div>
                      </Card>
                    </div>
                  )}
                </>
              );
            })()}

            {/* PAYMENTS HISTORY TABLE */}
            {customerPayments.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <Card>
                  <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
                    <h3 style={{ fontSize: 17, fontWeight: 600, color: '#0F0F10' }}>Payments History</h3>
                    <button onClick={() => navigate(`/invoices?customer=${id}`)}
                      className="cursor-pointer transition-colors"
                      style={{ background: 'none', border: '1px solid #E5E9EE', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: '#0F0F10' }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E9EE')}>
                      View All Payments
                    </button>
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.2fr)',
                    gap: 12, padding: '0 0 10px', borderBottom: '1px solid #E5E9EE',
                    fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
                  }}>
                    <span>Date</span><span>Amount</span><span>Method</span><span>For</span><span>Reference / Note</span>
                  </div>
                  {customerPayments.slice(0, 8).map(p => (
                    <div key={`${p.type}:${p.id}`} style={{
                      display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.2fr)',
                      gap: 12, padding: '14px 0', alignItems: 'center', borderBottom: '1px solid rgba(229,225,214,0.6)', fontSize: 13,
                    }}>
                      <span style={{ color: '#4B5563' }}>{fmtDate(p.receivedAt)}</span>
                      {p.type === 'payment' ? (
                        <span className="font-mono" style={{ color: '#16A34A' }}><Bhd v={p.amount}/> BHD</span>
                      ) : (
                        <span className="font-mono" style={{ color: '#DC2626' }}>{'-'}<Bhd v={p.amount}/> BHD</span>
                      )}
                      <span className="flex items-center gap-2" style={{ color: '#4B5563', textTransform: 'capitalize' }}>
                        <MethodIcon method={p.method} /> {p.method.replace('_', ' ')}
                      </span>
                      {p.type === 'payment' ? (
                        <Link to={`/invoices/${p.invoiceId}`} style={{ fontSize: 13, color: '#0F0F10', textDecoration: 'none' }}>
                          Invoice <span className="font-mono" style={{ color: '#3D7FFF' }}>{formatInvoiceDisplayShort({ invoiceNumber: p.invoiceNumber, status: p.invoiceStatus, specialMark: p.invoiceSpecialMark })}</span>
                        </Link>
                      ) : (
                        <Link to={`/invoices/${p.invoiceId}`} style={{ fontSize: 13, color: '#0F0F10', textDecoration: 'none' }}>
                          Return{' \u00b7 '}<span className="font-mono" style={{ color: '#DC2626' }}>{p.returnNumber}</span>
                        </Link>
                      )}
                      {p.type === 'payment' ? (
                        <span style={{ color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.notes || '\u2014'}</span>
                      ) : (
                        p.creditNoteId ? (
                          <Link to={`/credit-notes/${p.creditNoteId}`} style={{ fontSize: 13, color: '#715DE3', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            Credit Note
                          </Link>
                        ) : (
                          <span style={{ color: '#6B7280' }}>Refund</span>
                        )
                      )}
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 12 }}>
                    Showing {Math.min(8, customerPayments.length)} of {customerPayments.length} entr{customerPayments.length === 1 ? 'y' : 'ies'}
                  </div>
                </Card>
              </div>
            )}

            {/* INTERNAL NOTES + PREFERENCES + MATCHING — bottom row */}
            <div style={{ marginTop: 24 }}>
              <Card>
                <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                  <h3 style={{ fontSize: 17, fontWeight: 600, color: '#0F0F10' }}>Internal Notes</h3>
                  <button onClick={() => { setNoteDraft(customer.notes || ''); setNoteModal(true); }}
                    className="cursor-pointer transition-colors flex items-center gap-1"
                    style={{ background: 'none', border: '1px solid #E5E9EE', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: '#0F0F10' }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E9EE')}>
                    <Plus size={12} /> {customer.notes ? 'Edit Note' : 'Add Note'}
                  </button>
                </div>
                {customer.notes ? (
                  <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' }}>{customer.notes}</p>
                ) : (
                  <p style={{ fontSize: 13, color: '#9CA3AF', margin: 0 }}>No internal notes yet.</p>
                )}
              </Card>
            </div>

            {(customer.preferences.length > 0 || matchingProducts.length > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 24, marginTop: 24 }}>
                <Card>
                  <h3 style={{ fontSize: 15, fontWeight: 600, color: '#0F0F10', marginBottom: 12 }}>Preferences</h3>
                  {customer.preferences.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#9CA3AF' }}>No preferences set.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {customer.preferences.map(p => (
                        <span key={p} style={{ padding: '4px 12px', fontSize: 11, borderRadius: 999, border: '1px solid #D5D9DE', color: '#0F0F10' }}>{p}</span>
                      ))}
                    </div>
                  )}
                  {(customer.budgetMin || customer.budgetMax) && (
                    <div style={{ marginTop: 12, fontSize: 12, color: '#6B7280' }}>
                      Budget: <Bhd v={customer.budgetMin || 0}/> {'\u2013'} <Bhd v={customer.budgetMax || 0}/> BHD
                    </div>
                  )}
                </Card>
                <Card>
                  <h3 style={{ fontSize: 15, fontWeight: 600, color: '#0F0F10', marginBottom: 12 }}>Matching Items</h3>
                  {matchingProducts.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#9CA3AF' }}>No matching items.</p>
                  ) : (
                    <div>
                      {matchingProducts.map(p => (
                        <div key={p.id} className="flex items-center justify-between cursor-pointer rounded transition-colors"
                          onClick={() => navigate(`/collection/${p.id}`)}
                          style={{ padding: '8px 0', borderBottom: '1px solid #E5E9EE' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.02)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <div>
                            <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{p.brand}</span>
                            <div style={{ fontSize: 13, color: '#0F0F10' }}>{p.name}</div>
                          </div>
                          <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={p.plannedSalePrice || p.purchasePrice}/> BHD</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            )}
          </>
        )}
      </div>

      <Modal open={noteModal} onClose={() => setNoteModal(false)} title={customer.notes ? 'Edit Internal Note' : 'Add Internal Note'} width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTE</span>
            <textarea
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              placeholder="Internal note (only visible to staff)..."
              autoFocus
              rows={6}
              className="w-full"
              style={{ background: '#FFFFFF', border: '1px solid #D5D9DE', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#0F0F10', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  if (!id) return;
                  updateCustomer(id, { notes: noteDraft.trim() || undefined });
                  setNoteModal(false);
                }
              }} />
            <span style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4, display: 'block' }}>
              Tip: {'\u2318'} / Ctrl + Enter to save
            </span>
          </div>
          <div className="flex justify-between" style={{ alignItems: 'center' }}>
            {customer.notes ? (
              <button onClick={() => {
                if (!id) return;
                updateCustomer(id, { notes: undefined });
                setNoteModal(false);
              }} className="cursor-pointer"
                style={{ background: 'none', border: 'none', color: '#DC2626', fontSize: 12 }}>
                <Trash2 size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> Delete note
              </button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setNoteModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => {
                if (!id) return;
                updateCustomer(id, { notes: noteDraft.trim() || undefined });
                setNoteModal(false);
              }}>
                <Save size={12} /> Save Note
              </Button>
            </div>
          </div>
        </div>
      </Modal>

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

      <SettleGoldModal
        open={settleModal.open}
        mode={settleModal.mode}
        credit={settleModal.credit}
        onClose={() => setSettleModal({ open: false, mode: 'return_customer' })}
      />
    </div>
  );
}
