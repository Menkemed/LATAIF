import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Trash2, Save, ClipboardCheck, ExternalLink, Download, MessageCircle, FileText, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { useRepairStore } from '@/stores/repairStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { useProductStore } from '@/stores/productStore';
import { formatProductMultiLine } from '@/core/utils/product-format';
import { usePermission } from '@/hooks/usePermission';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import type { Repair, RepairStatus } from '@/core/models/types';
import { REPAIR_FIELDS, type RepairFieldDef } from '@/core/models/repair-fields';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Plan §Repair §6: RECEIVED → IN_PROGRESS → (SENT_TO_WORKSHOP if external) → READY → DELIVERED.
// Flow extended um SENT_TO_WORKSHOP wenn external; sonst direkt ready.
function getStatusFlow(repairType: string | undefined): RepairStatus[] {
  const base: RepairStatus[] = ['received', 'diagnosed', 'in_progress'];
  if (repairType === 'external' || repairType === 'hybrid') {
    return [...base, 'sent_to_workshop', 'ready', 'picked_up'];
  }
  return [...base, 'ready', 'picked_up'];
}

const STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  diagnosed: 'Diagnosed',
  in_progress: 'In Progress',
  sent_to_workshop: 'Sent to Workshop',
  ready: 'Ready for Pickup',
  picked_up: 'Picked Up',
  cancelled: 'Cancelled',
  returned: 'Returned',
  RECEIVED: 'Received',
  IN_PROGRESS: 'In Progress',
  SENT_TO_WORKSHOP: 'Sent to Workshop',
  READY: 'Ready for Pickup',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

function getNextStatus(current: RepairStatus, repairType?: string): RepairStatus | null {
  const flow = getStatusFlow(repairType);
  const idx = flow.indexOf(current);
  if (idx === -1 || idx >= flow.length - 1) return null;
  return flow[idx + 1];
}

export function RepairDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { repairs, loadRepairs, updateRepair, updateStatus, deleteRepair } = useRepairStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Repair>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const perm = usePermission();

  useEffect(() => { loadRepairs(); loadCustomers(); loadProducts(); loadCategories(); loadInvoices(); }, [loadRepairs, loadCustomers, loadProducts, loadCategories, loadInvoices]);

  const repair = useMemo(() => repairs.find(r => r.id === id), [repairs, id]);
  const customer = useMemo(() => repair ? customers.find(c => c.id === repair.customerId) : null, [repair, customers]);
  const product = useMemo(() => repair?.productId ? products.find(p => p.id === repair.productId) : null, [repair, products]);

  useEffect(() => {
    if (repair) setForm({ ...repair });
  }, [repair]);

  if (!repair) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Repair not found</p>
      </div>
    );
  }

  const nextStatus = getNextStatus(repair.status, repair.repairType);
  const margin = repair.chargeToCustomer != null && repair.internalCost != null
    ? repair.chargeToCustomer - repair.internalCost
    : null;

  // Plan §Repair §Pickup ↔ Payment (User-Spec): zwei orthogonale Status.
  // Payment wird aus Invoice abgeleitet wenn verlinkt, sonst aus customerPaymentStatus.
  // Pickup ist unabhängig — kein Payment-Gate mehr.
  const linkedInvoice = repair.invoiceId ? invoices.find(i => i.id === repair.invoiceId) : null;
  const charge = repair.chargeToCustomer || 0;
  const paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'FREE' = (() => {
    if (charge <= 0.005) return 'FREE';
    if (linkedInvoice) {
      const paid = linkedInvoice.paidAmount || 0;
      const gross = linkedInvoice.grossAmount || 0;
      if (gross > 0 && paid >= gross - 0.005) return 'PAID';
      if (paid > 0.005) return 'PARTIALLY_PAID';
      return 'UNPAID';
    }
    if (repair.customerPaymentStatus === 'PAID') return 'PAID';
    if (repair.customerPaymentStatus === 'PARTIALLY_PAID') return 'PARTIALLY_PAID';
    return 'UNPAID';
  })();
  const pickupStatus: 'NOT_PICKED_UP' | 'PICKED_UP' = repair.status === 'picked_up' ? 'PICKED_UP' : 'NOT_PICKED_UP';

  // Plan §Repair §Service-Invoice: Service-Item statt Lager-Produkt.
  // Lazy-seeded "Repair Service"-Produkt pro Branch (idempotent). VAT folgt
  // repair.taxScheme (vom New-Repair-Modal gewählt: 0% oder 10%).
  async function handleCreateRepairInvoice() {
    if (!repair || !id || !customer) return;
    if (!repair.chargeToCustomer || repair.chargeToCustomer <= 0) {
      alert('Repair has no charge — no invoice needed. Set Charge to Client first.');
      return;
    }
    if (repair.invoiceId) {
      const existing = invoices.find(i => i.id === repair.invoiceId);
      if (existing) {
        navigate(`/invoices/${existing.id}`);
        return;
      }
    }
    const { getOrCreateRepairServiceProductId } = await import('@/stores/repairStore');
    const { currentBranchId: getBranch } = await import('@/core/db/helpers');
    let branchId: string;
    try { branchId = getBranch(); } catch { branchId = 'branch-main'; }
    const productId = getOrCreateRepairServiceProductId(branchId);

    const grossCharge = repair.chargeToCustomer;
    const scheme = repair.taxScheme === 'ZERO' ? 'ZERO' : 'VAT_10';
    const rate = scheme === 'VAT_10' ? 10 : 0;
    // chargeToCustomer ist gross-incl-VAT. Bei VAT_10 → Net = gross/1.1.
    const netAmount = scheme === 'VAT_10' ? grossCharge / (1 + rate / 100) : grossCharge;
    const vatAmount = grossCharge - netAmount;

    const invoice = useInvoiceStore.getState().createDirectInvoice(
      repair.customerId,
      [{
        productId,
        unitPrice: netAmount,
        purchasePrice: repair.internalCost || 0,
        taxScheme: scheme,
        vatRate: rate,
        vatAmount,
        lineTotal: grossCharge,
      }],
      `Repair Service · ${repair.repairNumber}${repair.issueDescription ? ' · ' + repair.issueDescription : ''}`
    );
    if (invoice) {
      updateRepair(id, { invoiceId: invoice.id });
      navigate(`/invoices/${invoice.id}`);
    }
  }

  function handleSave() {
    if (!id) return;
    // Internal cost mirrors actual (or estimated if actual not yet set) unless explicitly overridden.
    const derivedInternal = form.actualCost ?? form.estimatedCost ?? 0;
    const effectiveInternal = form.internalCost && form.internalCost > 0
      ? form.internalCost
      : derivedInternal;
    const computedMargin = form.chargeToCustomer != null
      ? form.chargeToCustomer - effectiveInternal
      : undefined;
    updateRepair(id, {
      diagnosis: form.diagnosis,
      estimatedCost: form.estimatedCost,
      actualCost: form.actualCost,
      internalCost: effectiveInternal,
      chargeToCustomer: form.chargeToCustomer,
      customerPaidFrom: form.customerPaidFrom ?? null,
      internalPaidFrom: form.internalPaidFrom ?? null,
      margin: computedMargin,
      repairType: form.repairType,
      externalVendor: form.externalVendor,
      estimatedReady: form.estimatedReady,
      notes: form.notes,
      // Plan §Repair §Item-Details: kategoriebasierte Item-Attribute beim Save mitnehmen
      itemCategoryId: form.itemCategoryId,
      itemAttributes: form.itemAttributes,
      itemBrand: form.itemBrand,
      itemModel: form.itemModel,
      itemReference: form.itemReference,
      itemSerial: form.itemSerial,
      itemDescription: form.itemDescription,
      issueDescription: form.issueDescription,
      taxScheme: form.taxScheme,
    });
    setEditing(false);
  }

  function handleStatusAdvance() {
    if (!id || !nextStatus) return;
    try {
      updateStatus(id, nextStatus);
    } catch (err) {
      // Plan §Repair §Picked-Up-Gate: charge > 0 → Invoice + Payment vorher Pflicht.
      // updateStatus throwt mit verständlicher Fehlermeldung; an User durchreichen.
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDelete() {
    if (!id) return;
    deleteRepair(id);
    navigate('/repairs');
  }

  function handleDownloadVoucher() {
    if (!repair) return;
    // Plan §Print — Item-Beschreibung mit allen Specs (vom verknüpften Produkt falls vorhanden).
    const linkedProduct = repair.productId ? products.find(p => p.id === repair.productId) : undefined;
    const itemDesc = linkedProduct
      ? formatProductMultiLine(linkedProduct, categories)
      : `${repair.itemBrand || ''} ${repair.itemModel || ''}`.trim() || 'Item';
    downloadPdf({
      title: `Repair Voucher ${repair.repairNumber}`,
      number: repair.repairNumber,
      date: repair.receivedAt?.split('T')[0] || '',
      subtitle: `Status: ${repair.status.replace('_', ' ')}`,
      customer: customer ? { name: `${customer.firstName} ${customer.lastName}`, phone: customer.phone } : undefined,
      type: 'voucher',
      sections: [
        { title: 'Voucher Code', lines: [{ label: 'Present this code at pickup', value: repair.voucherCode, bold: true }] },
        { title: 'Item', lines: [
          { label: itemDesc, value: '' },
          ...(repair.itemReference && !linkedProduct ? [{ label: 'Reference', value: repair.itemReference }] : []),
          ...(repair.itemSerial && !linkedProduct ? [{ label: 'Serial', value: repair.itemSerial }] : []),
          { label: 'Issue', value: repair.issueDescription },
        ]},
        ...(repair.estimatedReady ? [{ title: 'Schedule', lines: [
          { label: 'Estimated Ready', value: repair.estimatedReady.split('T')[0] },
        ]}] : []),
        ...(repair.chargeToCustomer != null ? [{ title: 'Amount', lines: [
          { label: 'Charge to Customer', value: `${fmt(repair.chargeToCustomer)} BHD`, bold: true },
        ]}] : []),
      ],
      footer: 'Please keep this voucher for pickup. Contact us for status updates.',
    });
  }

  function renderField(label: string, value: React.ReactNode, editField?: React.ReactNode) {
    return (
      <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
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
          <button onClick={() => navigate('/repairs')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Repairs
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...repair }); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                {nextStatus && perm.canManageRepairs && (
                  <Button variant="primary" onClick={handleStatusAdvance}>
                    <ClipboardCheck size={14} /> Mark as {STATUS_LABELS[nextStatus]}
                  </Button>
                )}
                {/* User-Spec §Repair Return: Ware ohne Reparatur zurück. Sichtbar in
                    allen nicht-terminalen Status (received bis ready). */}
                {perm.canManageRepairs && repair.status !== 'picked_up' && repair.status !== 'returned'
                  && repair.status !== 'cancelled' && repair.status !== 'CANCELLED' && repair.status !== 'DELIVERED' && (
                  <Button variant="secondary" onClick={() => {
                    if (!id) return;
                    if (!window.confirm(`Mark repair ${repair.repairNumber} as returned to customer (no repair performed)?`)) return;
                    try { updateStatus(id, 'returned'); }
                    catch (err) { alert(err instanceof Error ? err.message : String(err)); }
                  }}>
                    <RotateCcw size={14} /> Mark as Returned
                  </Button>
                )}
                {repair.status === 'ready' && customer && (
                  <>
                    <Button variant="secondary" onClick={() => setShowMessage(true)}>
                      <MessageCircle size={14} /> AI Notify
                    </Button>
                    {/* Plan §Repair §12: Wenn fertig → Invoice erstellen (INV) */}
                    {!repair.invoiceId && repair.chargeToCustomer != null && repair.chargeToCustomer > 0 && perm.canCreateInvoices && (
                      <Button variant="primary" onClick={handleCreateRepairInvoice}>
                        <FileText size={14} /> Create Invoice
                      </Button>
                    )}
                    {repair.invoiceId && (
                      <Button variant="ghost" onClick={() => navigate(`/invoices/${repair.invoiceId}`)}>
                        <ExternalLink size={14} /> View Invoice
                      </Button>
                    )}
                  </>
                )}
                <Button variant="secondary" onClick={handleDownloadVoucher}><Download size={14} /> Voucher</Button>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                {perm.canManageRepairs && <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>}
              </>
            )}
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>

          {/* Voucher & Status */}
          <div>
            {/* Voucher Code - prominent display */}
            <div className="rounded-xl flex flex-col items-center justify-center"
              style={{ height: 220, background: '#F2F7FA', border: '1px solid #E5E9EE', marginBottom: 24 }}>
              <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Pickup Voucher Code</span>
              <span className="font-mono" style={{ fontSize: 48, color: '#0F0F10', letterSpacing: '0.15em', fontWeight: 600 }}>
                {repair.voucherCode}
              </span>
              <span style={{ fontSize: 12, color: '#6B7280', marginTop: 12 }}>Customer presents this code for pickup</span>
            </div>

            {/* Status Timeline */}
            <div style={{ padding: '16px 20px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>STATUS FLOW</span>
              <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                {(() => {
                  const flow = getStatusFlow(repair.repairType);
                  const currentIdx = flow.indexOf(repair.status);
                  return flow.map((s, i) => {
                    const isActive = i <= currentIdx;
                    const isCurrent = s === repair.status;
                    return (
                      <div key={s} className="flex items-center gap-2">
                        <span style={{
                          fontSize: 12,
                          padding: '4px 10px',
                          borderRadius: 4,
                          background: isCurrent ? 'rgba(15,15,16,0.1)' : 'transparent',
                          color: isCurrent ? '#0F0F10' : isActive ? '#0F0F10' : '#6B7280',
                          border: isCurrent ? '1px solid rgba(15,15,16,0.15)' : '1px solid transparent',
                          fontWeight: isCurrent ? 500 : 400,
                        }}>
                          {STATUS_LABELS[s] || s}
                        </span>
                        {i < flow.length - 1 && (
                          <span style={{ color: isActive ? '#6B7280' : '#D5D9DE', fontSize: 10 }}>&#8250;</span>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>

              {/* Payment + Pickup als zwei unabhängige Status (User-Spec) — sichtbar
                  ab Ready, weil davor noch nichts zum Bezahlen/Abholen da ist. */}
              {(repair.status === 'ready' || repair.status === 'picked_up') && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #E5E9EE', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <span style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Payment</span>
                    <span style={{
                      fontSize: 12, padding: '4px 10px', borderRadius: 999, display: 'inline-block',
                      background: paymentStatus === 'PAID' || paymentStatus === 'FREE' ? 'rgba(126,170,110,0.12)'
                        : paymentStatus === 'PARTIALLY_PAID' ? 'rgba(170,149,110,0.12)'
                        : 'rgba(170,110,110,0.12)',
                      color: paymentStatus === 'PAID' || paymentStatus === 'FREE' ? '#5C8550'
                        : paymentStatus === 'PARTIALLY_PAID' ? '#8A7548'
                        : '#8A4848',
                      border: `1px solid ${paymentStatus === 'PAID' || paymentStatus === 'FREE' ? 'rgba(126,170,110,0.4)'
                        : paymentStatus === 'PARTIALLY_PAID' ? 'rgba(170,149,110,0.4)'
                        : 'rgba(170,110,110,0.4)'}`,
                    }}>
                      {paymentStatus === 'FREE' ? 'Free Repair'
                        : paymentStatus === 'PAID' ? 'Paid'
                        : paymentStatus === 'PARTIALLY_PAID' ? 'Partially Paid'
                        : 'Unpaid'}
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Pickup</span>
                    <span style={{
                      fontSize: 12, padding: '4px 10px', borderRadius: 999, display: 'inline-block',
                      background: pickupStatus === 'PICKED_UP' ? 'rgba(126,170,110,0.12)' : 'rgba(107,114,128,0.10)',
                      color: pickupStatus === 'PICKED_UP' ? '#5C8550' : '#6B7280',
                      border: `1px solid ${pickupStatus === 'PICKED_UP' ? 'rgba(126,170,110,0.4)' : 'rgba(107,114,128,0.3)'}`,
                    }}>
                      {pickupStatus === 'PICKED_UP' ? 'Picked Up' : 'Not Picked Up'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Key Info */}
          <div>
            <span className="text-overline">{repair.repairNumber}</span>
            <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>
              {repair.itemBrand ? `${repair.itemBrand} ${repair.itemModel || ''}`.trim() : 'Repair Service'}
            </h1>
            {repair.itemReference && (
              <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 8 }}>
                Ref: {repair.itemReference}
              </span>
            )}
            <div className="flex items-center gap-4" style={{ marginTop: 12 }}>
              <StatusDot status={repair.status} />
              <span style={{ fontSize: 13, color: '#4B5563' }}>
                {repair.repairType === 'external' ? 'External Repair' : repair.repairType === 'hybrid' ? 'Hybrid Repair' : 'Internal Repair'}
              </span>
            </div>

            {/* Customer */}
            <div style={{ marginTop: 20, borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>CUSTOMER</span>
              <span style={{ fontSize: 15, color: '#0F0F10' }}>
                {customer ? `${customer.firstName} ${customer.lastName}` : repair.customerId}
              </span>
              {customer?.phone && (
                <span style={{ fontSize: 13, color: '#6B7280', display: 'block', marginTop: 4 }}>{customer.phone}</span>
              )}
            </div>

            {/* Costs */}
            <div style={{ marginTop: 20, borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
              {editing ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Input label="ESTIMATED COST (BHD)" type="number" value={form.estimatedCost ?? ''} onChange={e => setForm({ ...form, estimatedCost: e.target.value ? Number(e.target.value) : undefined })} />
                  <Input label="ACTUAL COST (BHD)" type="number" value={form.actualCost ?? ''} onChange={e => setForm({ ...form, actualCost: e.target.value ? Number(e.target.value) : undefined })} />
                  <Input label="INTERNAL COST (BHD)" type="number" value={form.internalCost ?? 0} onChange={e => setForm({ ...form, internalCost: Number(e.target.value) })} />
                  <Input label="CHARGE TO CUSTOMER (BHD)" type="number" value={form.chargeToCustomer ?? ''} onChange={e => setForm({ ...form, chargeToCustomer: e.target.value ? Number(e.target.value) : undefined })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>INTERNAL PAID FROM</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
                      {([null, 'cash', 'bank'] as const).map(o => {
                        const active = (form.internalPaidFrom ?? null) === o;
                        return (
                          <button key={String(o)} type="button" onClick={() => setForm({ ...form, internalPaidFrom: o })}
                            className="cursor-pointer rounded transition-all"
                            style={{ padding: '7px 14px', fontSize: 12,
                              border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                              color: active ? '#0F0F10' : '#6B7280',
                              background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{o === null ? 'None' : o === 'cash' ? 'Cash' : 'Bank'}</button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>CUSTOMER PAID WITH</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
                      {([null, 'cash', 'bank'] as const).map(o => {
                        const active = (form.customerPaidFrom ?? null) === o;
                        return (
                          <button key={String(o)} type="button" onClick={() => setForm({ ...form, customerPaidFrom: o })}
                            className="cursor-pointer rounded transition-all"
                            style={{ padding: '7px 14px', fontSize: 12,
                              border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                              color: active ? '#0F0F10' : '#6B7280',
                              background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{o === null ? 'None' : o === 'cash' ? 'Cash' : 'Bank'}</button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {repair.estimatedCost != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">ESTIMATED COST</span>
                      <span className="font-display" style={{ fontSize: 16, color: '#4B5563' }}>{fmt(repair.estimatedCost)} BHD</span>
                    </div>
                  )}
                  {repair.actualCost != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">ACTUAL COST</span>
                      <span className="font-display" style={{ fontSize: 16, color: '#4B5563' }}>{fmt(repair.actualCost)} BHD</span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">INTERNAL COST</span>
                    <span className="font-display" style={{ fontSize: 16, color: '#4B5563' }}>{fmt(repair.internalCost)} BHD</span>
                  </div>
                  {repair.chargeToCustomer != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">CHARGE TO CUSTOMER</span>
                      <span className="font-display" style={{ fontSize: 20, color: '#0F0F10' }}>{fmt(repair.chargeToCustomer)} BHD</span>
                    </div>
                  )}
                  {repair.customerPaidFrom && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">CUSTOMER PAID WITH</span>
                      <span style={{ fontSize: 13, color: '#4B5563' }}>{repair.customerPaidFrom === 'cash' ? 'Cash' : 'Bank'}</span>
                    </div>
                  )}
                  {repair.internalPaidFrom && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">INTERNAL PAID FROM</span>
                      <span style={{ fontSize: 13, color: '#4B5563' }}>{repair.internalPaidFrom === 'cash' ? 'Cash' : 'Bank'}</span>
                    </div>
                  )}
                  {margin != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">MARGIN</span>
                      <span className="font-mono" style={{ fontSize: 16, color: margin >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                        {fmt(margin)} BHD
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Details Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

          {/* Repair Info */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>REPAIR DETAILS</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Repair Type */}
                  <div>
                    <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Repair Type</span>
                    <div className="flex flex-wrap gap-1">
                      {(['internal', 'external', 'hybrid'] as Repair['repairType'][]).map(t => (
                        <button key={t} onClick={() => setForm({ ...form, repairType: t })}
                          className="cursor-pointer" style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                            background: form.repairType === t ? 'rgba(15,15,16,0.1)' : 'transparent',
                            color: form.repairType === t ? '#0F0F10' : '#6B7280',
                          }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
                      ))}
                    </div>
                  </div>
                  <Input label="EXTERNAL VENDOR" value={form.externalVendor || ''} onChange={e => setForm({ ...form, externalVendor: e.target.value || undefined })} />
                  <Input label="ESTIMATED READY DATE" type="date" value={form.estimatedReady || ''} onChange={e => setForm({ ...form, estimatedReady: e.target.value || undefined })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>DIAGNOSIS</span>
                    <textarea
                      value={form.diagnosis || ''}
                      onChange={e => setForm({ ...form, diagnosis: e.target.value || undefined })}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                    <textarea
                      value={form.notes || ''}
                      onChange={e => setForm({ ...form, notes: e.target.value || undefined })}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {renderField('Repair Type', repair.repairType.charAt(0).toUpperCase() + repair.repairType.slice(1))}
                  {repair.externalVendor && renderField('External Vendor', repair.externalVendor)}
                  {renderField('Received', repair.receivedAt ? new Date(repair.receivedAt).toLocaleDateString() : undefined)}
                  {repair.diagnosedAt && renderField('Diagnosed', new Date(repair.diagnosedAt).toLocaleDateString())}
                  {repair.startedAt && renderField('Started', new Date(repair.startedAt).toLocaleDateString())}
                  {repair.completedAt && renderField('Completed', new Date(repair.completedAt).toLocaleDateString())}
                  {repair.pickedUpAt && renderField('Picked Up', new Date(repair.pickedUpAt).toLocaleDateString())}
                  {repair.estimatedReady && renderField('Estimated Ready', new Date(repair.estimatedReady).toLocaleDateString())}
                  {repair.diagnosis && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Diagnosis</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{repair.diagnosis}</p>
                    </div>
                  )}
                  {repair.notes && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{repair.notes}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>

          {/* Item & Product Info */}
          <Card>
            <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
              <span className="text-overline">ITEM INFORMATION</span>
              {repair.itemCategoryId && (() => {
                const cat = categories.find(c => c.id === repair.itemCategoryId);
                if (!cat) return null;
                return (
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 999,
                    background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                  }}>{cat.name}</span>
                );
              })()}
            </div>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <RepairItemEditor
                  form={form}
                  setForm={setForm}
                  categories={categories.filter(c => !c.id.startsWith('cat-repair-service'))}
                />
              ) : (
                <>
                  {/* Top-Level item-Felder (Legacy + core fields) */}
                  {repair.itemBrand && renderField('Brand', repair.itemBrand)}
                  {repair.itemModel && renderField('Model', repair.itemModel)}
                  {repair.itemReference && renderField('Reference', repair.itemReference)}
                  {repair.itemSerial && renderField('Serial Number', repair.itemSerial)}
                  {/* Kategoriespezifische Attribute aus item_attributes */}
                  {repair.itemCategoryId && repair.itemAttributes && (() => {
                    const fields = REPAIR_FIELDS[repair.itemCategoryId] || [];
                    return fields
                      .filter(f => !f.coreField)
                      .map(f => {
                        const v = repair.itemAttributes?.[f.key];
                        if (v === undefined || v === '') return null;
                        const display = f.unit ? `${v} ${f.unit}` : String(v);
                        return <div key={f.key}>{renderField(f.label, display)}</div>;
                      });
                  })()}
                  {repair.itemDescription && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Item Description</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{repair.itemDescription}</p>
                    </div>
                  )}
                </>
              )}

              {/* Issue Description */}
              <div style={{ marginTop: 16 }}>
                <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Issue Description</span>
                {editing ? (
                  <textarea value={form.issueDescription || ''}
                    onChange={e => setForm({ ...form, issueDescription: e.target.value })}
                    rows={3}
                    style={{ width: '100%', background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical' }} />
                ) : (
                  <p style={{ fontSize: 13, color: '#0F0F10', lineHeight: 1.6 }}>{repair.issueDescription || '\u2014'}</p>
                )}
              </div>

              {/* Linked Product */}
              {product && (
                <div style={{ marginTop: 20, padding: '12px 14px', background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span style={{ fontSize: 11, color: '#6B7280', display: 'block', marginBottom: 4 }}>Linked Product</span>
                      <span style={{ fontSize: 14, color: '#0F0F10' }}>{product.brand} {product.name}</span>
                      {product.sku && <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', display: 'block', marginTop: 2 }}>{product.sku}</span>}
                    </div>
                    <button
                      onClick={() => navigate(`/collection/${product.id}`)}
                      className="flex items-center gap-1 cursor-pointer transition-colors"
                      style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 12 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#0F0F10')}
                    >
                      <ExternalLink size={12} /> View
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Delete button in edit mode */}
            {editing && repair.status !== 'picked_up' && perm.canDeleteRepairs && (
              <div className="flex gap-2" style={{ marginTop: 20 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Repair
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>

      {customer && (
        <MessagePreviewModal
          open={showMessage}
          onClose={() => setShowMessage(false)}
          type="repair_ready"
          customerId={customer.id}
          customerName={`${customer.firstName} ${customer.lastName}`}
          customerPhone={customer.phone}
          customerWhatsapp={customer.whatsapp}
          productImage={repair.images?.[0] || product?.images?.[0]}
          productLabel={repair.itemBrand ? `${repair.itemBrand} ${repair.itemModel || ''}`.trim() : (product ? `${product.brand} ${product.name}` : undefined)}
          details={`Voucher code: ${repair.voucherCode}. Repair: ${repair.repairNumber}.${repair.chargeToCustomer ? ` Amount due: ${repair.chargeToCustomer} BHD.` : ''}`}
          linkedEntityType="repair"
          linkedEntityId={repair.id}
        />
      )}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Repair" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete repair <strong style={{ color: '#0F0F10' }}>{repair.repairNumber}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="repairs"
        entityId={repair.id}
        title={`History · ${repair.repairNumber}`}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Plan §Repair §Item-Details Edit-Mode: kategorie-basierte Item-Editor-Komponente.
// Wiederverwendet die REPAIR_FIELDS-Config (geteilt mit RepairList).
// ──────────────────────────────────────────────────────────────────────────
interface RepairItemEditorProps {
  form: Partial<Repair>;
  setForm: (v: Partial<Repair>) => void;
  categories: Array<{ id: string; name: string; color: string }>;
}
function RepairItemEditor({ form, setForm, categories }: RepairItemEditorProps) {
  const activeFields: RepairFieldDef[] = form.itemCategoryId ? (REPAIR_FIELDS[form.itemCategoryId] || []) : [];

  function setAttr(key: string, value: string | number | boolean) {
    setForm({ ...form, itemAttributes: { ...(form.itemAttributes || {}), [key]: value } });
  }
  function setCore(field: NonNullable<RepairFieldDef['coreField']>, value: string) {
    setForm({ ...form, [field]: value });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Kategorie-Chips */}
      <div>
        <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>CATEGORY</span>
        <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
          {categories.map(cat => {
            const active = form.itemCategoryId === cat.id;
            return (
              <button key={cat.id}
                onClick={() => setForm({ ...form, itemCategoryId: cat.id, itemAttributes: {} })}
                className="cursor-pointer rounded-lg transition-all duration-200"
                style={{
                  padding: '8px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                  border: `1px solid ${active ? cat.color : '#D5D9DE'}`,
                  color: active ? cat.color : '#6B7280',
                  background: active ? cat.color + '08' : 'transparent',
                }}>
                <span className="rounded-full" style={{ width: 5, height: 5, background: cat.color }} />
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Kategoriespezifische Felder */}
      {activeFields.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {activeFields.map(field => {
            const value = field.coreField
              ? (form[field.coreField] as string | undefined) || ''
              : (form.itemAttributes?.[field.key] as string | number | undefined) ?? '';
            if (field.type === 'select' && field.options) {
              return (
                <div key={field.key}>
                  <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                    {field.label.toUpperCase()}
                    {field.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                  </span>
                  <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                    {field.options.map(opt => {
                      const sel = value === opt;
                      return (
                        <button key={opt}
                          onClick={() => field.coreField ? setCore(field.coreField, opt) : setAttr(field.key, opt)}
                          className="cursor-pointer transition-all duration-200"
                          style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 999,
                            border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                            color: sel ? '#0F0F10' : '#6B7280',
                            background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}>{opt}</button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (
              <Input key={field.key}
                required={field.required}
                label={field.label.toUpperCase() + (field.unit ? ` (${field.unit})` : '')}
                type={field.type === 'number' ? 'number' : 'text'}
                value={String(value)}
                onChange={e => {
                  const v = field.type === 'number' ? Number(e.target.value) : e.target.value;
                  if (field.coreField) setCore(field.coreField, String(v));
                  else setAttr(field.key, v);
                }}
              />
            );
          })}
        </div>
      )}

      {/* Generic Brand/Model fallback wenn keine Kategorie */}
      {!form.itemCategoryId && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input label="BRAND" value={form.itemBrand || ''} onChange={e => setForm({ ...form, itemBrand: e.target.value })} />
          <Input label="MODEL" value={form.itemModel || ''} onChange={e => setForm({ ...form, itemModel: e.target.value })} />
        </div>
      )}

      <Input label="ITEM DESCRIPTION (OPTIONAL)" value={form.itemDescription || ''}
        onChange={e => setForm({ ...form, itemDescription: e.target.value })} />
    </div>
  );
}
