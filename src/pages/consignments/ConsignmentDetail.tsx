import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Save, Trash2, AlertTriangle, FileText, Receipt, ShoppingBag, Package } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { usePermission } from '@/hooks/usePermission';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { Bhd } from '@/components/ui/Bhd';
import { getProductSpecs } from '@/core/utils/product-format';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { computeConsignmentSale, commissionLineLabel, commissionModelLabel } from '@/core/consignment/economics';

function fmtPct(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function daysUntil(dateStr: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function ConsignmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/consignments');
  const {
    consignments, loadConsignments, updateConsignment,
    recordSale, cancelSale, markPaidOut, markReturned, markReturnedAfterSale, deleteConsignment,
  } = useConsignmentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  const { expenses, loadExpenses } = useExpenseStore();
  const { employees, loadEmployees } = useEmployeeStore();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    agreedPrice: string;
    minimumPrice: string;
    commissionRate: string;
    expiryDate: string;
    notes: string;
  }>({ agreedPrice: '', minimumPrice: '', commissionRate: '', expiryDate: '', notes: '' });

  // Modals
  const [soldModal, setSoldModal] = useState(false);
  const [soldPrice, setSoldPrice] = useState('');
  const [soldBuyer, setSoldBuyer] = useState('');
  const [soldDate, setSoldDate] = useState('');
  const [soldNotes, setSoldNotes] = useState('');
  const [soldAck, setSoldAck] = useState(false);
  const [paidModal, setPaidModal] = useState(false);
  const [paidMethod, setPaidMethod] = useState('bank_transfer');
  const [paidRef, setPaidRef] = useState('');
  const [returnModal, setReturnModal] = useState(false);
  const [postSaleReturnModal, setPostSaleReturnModal] = useState(false);
  const [postSaleDisposition, setPostSaleDisposition] = useState<'RETURN_TO_OWNER' | 'KEEP_AS_OWN'>('RETURN_TO_OWNER');
  const [cancelSaleModal, setCancelSaleModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // 2026-05-16 — Number-Type-Dialog vor Auto-Invoice.
  const [numberDialogOpen, setNumberDialogOpen] = useState(false);
  const perm = usePermission();

  useEffect(() => {
    loadConsignments();
    loadCustomers();
    loadProducts();
    loadCategories();
    loadInvoices();
    loadPurchases();
    loadExpenses();
    loadEmployees();
  }, [loadConsignments, loadCustomers, loadProducts, loadCategories, loadInvoices, loadPurchases, loadExpenses, loadEmployees]);

  const consignment = useMemo(
    () => consignments.find(c => c.id === id),
    [consignments, id],
  );

  const consignor = useMemo(
    () => consignment ? customers.find(c => c.id === consignment.consignorId) : null,
    [consignment, customers],
  );

  const product = useMemo(
    () => consignment ? products.find(p => p.id === consignment.productId) : null,
    [consignment, products],
  );

  const buyer = useMemo(
    () => consignment?.buyerId ? customers.find(c => c.id === consignment.buyerId) : null,
    [consignment, customers],
  );

  // Linked records (für Sold-Card Anzeige).
  // WICHTIG: useMemo MUSS vor dem `if (!consignment) return ...` stehen — sonst
  // springt die Hook-Anzahl zwischen Renders und React explodiert mit
  // "Rendered more hooks than during the previous render".
  const linkedPurchase = useMemo(() => {
    if (!consignment) return null;
    if (consignment.status !== 'sold' && consignment.status !== 'paid_out') return null;
    return purchases.find(p => (p.notes || '').includes(consignment.consignmentNumber)) || null;
  }, [purchases, consignment]);
  const linkedLossExpense = useMemo(() => {
    if (!consignment) return null;
    if (consignment.status !== 'sold' && consignment.status !== 'paid_out') return null;
    return expenses.find(e =>
      e.relatedModule === 'consignment' && e.relatedEntityId === consignment.id && e.category === 'ConsignorLoss'
    ) || null;
  }, [expenses, consignment]);

  // Sync form when consignment loads
  useEffect(() => {
    if (consignment) {
      setForm({
        agreedPrice: String(consignment.agreedPrice),
        minimumPrice: consignment.minimumPrice != null ? String(consignment.minimumPrice) : '',
        commissionRate: String(consignment.commissionRate),
        expiryDate: consignment.expiryDate || '',
        notes: consignment.notes || '',
      });
    }
  }, [consignment]);

  if (!consignment) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Consignment not found</p>
      </div>
    );
  }

  // Expiry warning
  const expiryDays = consignment.expiryDate ? daysUntil(consignment.expiryDate) : null;
  const expiryWarning = expiryDays !== null && expiryDays <= 14 && consignment.status === 'active';

  // Live edit calculations
  const editAgreed = Number(form.agreedPrice) || 0;
  const editRate = Number(form.commissionRate) || 0;
  const editCommission = editAgreed * (editRate / 100);
  const editPayout = editAgreed - editCommission;

  // Sale modal calculations — SSOT economics (percent/consignor_fixed/cost_split).
  const salePriceNum = Number(soldPrice) || 0;
  const saleEcon = computeConsignmentSale(consignment, salePriceNum);
  const saleCommission = saleEcon.commission;
  const salePayout = saleEcon.payout;
  // Shortfall (Verkauf unter Floor) gilt für consignor_fixed UND cost_split.
  const saleNeedsAck = salePriceNum > 0 && saleEcon.belowFloor;
  const saleShortfall = saleNeedsAck ? saleEcon.loss : 0;
  const buyerIsConsignor = !!soldBuyer && soldBuyer === consignment.consignorId;

  // Linked invoice (no useMemo needed — simple lookup, can stay after early return).
  const linkedInvoice = consignment.invoiceId ? invoices.find(i => i.id === consignment.invoiceId) : null;

  function handleSave() {
    if (!id) return;
    updateConsignment(id, {
      agreedPrice: Number(form.agreedPrice) || consignment!.agreedPrice,
      minimumPrice: form.minimumPrice ? Number(form.minimumPrice) : undefined,
      commissionRate: Number(form.commissionRate) || consignment!.commissionRate,
      expiryDate: form.expiryDate || undefined,
      notes: form.notes || undefined,
    });
    setEditing(false);
  }

  function handleRecordSale() {
    if (!id || !soldPrice || !soldBuyer) return;
    if (buyerIsConsignor) {
      alert('Buyer cannot be the same as the consignor. Use "Return" if the consignor is taking the item back.');
      return;
    }
    if (saleNeedsAck && !soldAck) {
      alert('Please confirm the consignor-loss shortfall before saving.');
      return;
    }
    setNumberDialogOpen(true);
  }

  function executeRecordSale(specialMark: boolean) {
    if (!id) return;
    try {
      recordSale(id, {
        salePrice: Number(soldPrice),
        buyerId: soldBuyer,
        saleDate: soldDate || new Date().toISOString().split('T')[0],
        notes: soldNotes || undefined,
        acknowledgeShortfall: soldAck,
        specialMark,
      });
      setNumberDialogOpen(false);
      setSoldModal(false);
      setSoldPrice(''); setSoldBuyer(''); setSoldDate(''); setSoldNotes(''); setSoldAck(false);
    } catch (e) {
      alert(`Sale failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleMarkPaid() {
    if (!id) return;
    markPaidOut(id, paidMethod, paidRef || undefined);
    setPaidModal(false);
    setPaidMethod('bank_transfer');
    setPaidRef('');
  }

  function handleReturn() {
    if (!id) return;
    markReturned(id);
    setReturnModal(false);
  }

  function handlePostSaleReturn() {
    if (!id) return;
    markReturnedAfterSale(id, postSaleDisposition);
    setPostSaleReturnModal(false);
  }

  function handleCancelSale() {
    if (!id) return;
    try {
      cancelSale(id);
      setCancelSaleModal(false);
    } catch (e) {
      alert(`Cancel Sale failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleDelete() {
    if (!id) return;
    deleteConsignment(id);
    navigate('/consignments');
  }

  const consignorName = consignor
    ? `${consignor.firstName} ${consignor.lastName}`
    : '\u2014';

  const productLabel = product
    ? `${product.brand} ${product.name}`
    : '\u2014';

  // 2026-05-18: Layout neu im Transfer-Detail-Stil (KPI-Strip / Action-Bar /
  // Item+Consignor-Row / Meta-Footer). Edit ist jetzt ein Modal statt Inline.
  const outstandingPayout = consignment.status === 'sold'
    ? (linkedPurchase
        ? Math.max(0, (linkedPurchase.totalAmount || 0) - (linkedPurchase.paidAmount || 0))
        : (consignment.payoutStatus !== 'paid' ? (consignment.payoutAmount || 0) : 0))
    : 0;
  const consignmentSubtitle = `Consignor: ${consignorName}`;
  const transferredDate = consignment.agreementDate || (consignment.createdAt || '').split('T')[0];
  const soldOnDate = consignment.status === 'sold' && consignment.updatedAt
    ? consignment.updatedAt.split('T')[0]
    : '';
  const returnedOnDate = (consignment.status === 'returned' || consignment.status === 'paid_out') && consignment.updatedAt
    ? consignment.updatedAt.split('T')[0]
    : '';

  function openEditModal() {
    setForm({
      agreedPrice: String(consignment!.agreedPrice),
      minimumPrice: consignment!.minimumPrice != null ? String(consignment!.minimumPrice) : '',
      commissionRate: String(consignment!.commissionRate),
      expiryDate: consignment!.expiryDate || '',
      notes: consignment!.notes || '',
    });
    setEditing(true);
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>

        {/* Back */}
        <button onClick={goBack}
          className="flex items-center gap-2 cursor-pointer transition-colors"
          style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13, marginBottom: 12 }}
          onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
          onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
        >
          <ArrowLeft size={16} /> Back
        </button>

        {/* Title */}
        <div style={{ marginBottom: 18 }}>
          <h1 className="font-display" style={{ fontSize: 26, color: '#0F0F10', lineHeight: 1.2 }}>
            Consignment {consignment.consignmentNumber}
          </h1>
          <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{consignmentSubtitle}</p>
        </div>

        {/* Hero KPI Card — Agreed · Sale · Payout · Outstanding */}
        <Card style={{ padding: 18, marginBottom: 18 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
            <div className="flex items-center gap-3">
              <span className="font-mono" style={{ fontSize: 15, color: '#0F0F10', fontWeight: 600 }}>
                {consignment.consignmentNumber}
              </span>
              <StatusDot status={consignment.status} />
              {consignment.payoutStatus !== 'pending' && consignment.status !== 'active' && (
                <StatusDot status={consignment.payoutStatus} label={`Payout: ${consignment.payoutStatus.replace(/_/g, ' ')}`} />
              )}
            </div>
            <span style={{ fontSize: 11, color: '#9CA3AF' }}>
              consigned {transferredDate || '—'}
              {soldOnDate && ` · sold ${soldOnDate}`}
              {returnedOnDate && consignment.status === 'returned' && ` · returned ${returnedOnDate}`}
              {returnedOnDate && consignment.status === 'paid_out' && ` · paid out ${returnedOnDate}`}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Agreed Price', value: consignment.agreedPrice || 0, color: '#4B5563' },
              { label: 'Sale Price', value: consignment.salePrice ?? 0, color: '#0F0F10' },
              { label: 'Payout', value: consignment.payoutAmount ?? 0, color: (consignment.payoutAmount ?? 0) > 0 ? '#16A34A' : '#6B7280' },
              { label: 'Outstanding Payout', value: outstandingPayout, color: outstandingPayout > 0 ? '#DC2626' : '#6B7280' },
            ].map(k => (
              <div key={k.label} style={{
                padding: '10px 12px', borderRadius: 8,
                background: '#FAFBFC', border: '1px solid #E5E9EE',
              }}>
                <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                  {k.label}
                </div>
                <div className="font-mono" style={{ fontSize: 16, color: k.color, fontWeight: 600 }}>
                  <Bhd v={k.value} /> <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 400 }}>BHD</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Actions Card — Status-abhaengige Buttons; Delete rechts */}
        {perm.canManageConsignments && (
          <Card style={{ padding: 14, marginBottom: 18 }}>
            <div className="flex flex-wrap gap-2">
              {consignment.status === 'active' && (
                <>
                  <Button variant="primary" onClick={() => {
                    setSoldPrice(String(consignment.agreedPrice || ''));
                    setSoldBuyer('');
                    setSoldDate(new Date().toISOString().split('T')[0]);
                    setSoldNotes('');
                    setSoldAck(false);
                    setSoldModal(true);
                  }}>
                    Record Sale
                  </Button>
                  <Button variant="ghost" onClick={() => setReturnModal(true)}>Return</Button>
                </>
              )}
              {consignment.status === 'sold' && (
                <>
                  {consignment.invoiceId && linkedInvoice && (
                    <Button variant="primary" onClick={() => navigate(`/invoices/${consignment.invoiceId}`)}>
                      <FileText size={14} /> Open Invoice ({formatInvoiceDisplayShort(linkedInvoice)})
                    </Button>
                  )}
                  {linkedPurchase && (
                    <Button variant="secondary" onClick={() => navigate(`/purchases/${linkedPurchase.id}`)}>
                      <ShoppingBag size={14} /> Consignor Purchase
                    </Button>
                  )}
                  {!consignment.invoiceId && (
                    <Button variant="primary" onClick={() => setPaidModal(true)}>Pay Out (legacy)</Button>
                  )}
                  <Button variant="ghost" onClick={() => setPostSaleReturnModal(true)}>Post-Sale Return</Button>
                  {consignment.invoiceId && (
                    <Button variant="ghost" onClick={() => setCancelSaleModal(true)}>Cancel Sale</Button>
                  )}
                </>
              )}
              {consignment.status === 'returned' && consignment.invoiceId && (
                <Button variant="ghost" onClick={() => setCancelSaleModal(true)}>Cancel Sale (cleanup)</Button>
              )}
              {consignment.status === 'paid_out' && (
                <>
                  <Button variant="ghost" onClick={() => setPostSaleReturnModal(true)}>Post-Sale Return</Button>
                  {/* paid_out-Teardown: bewusst OHNE invoiceId-Bedingung — die real
                      existierende paid_out-Population stammt aus dem Legacy-Pfad
                      (markPaidOut ohne Invoice); der Store-Flow deckt beide Fälle. */}
                  <Button variant="ghost" onClick={() => setCancelSaleModal(true)}>Cancel Sale</Button>
                </>
              )}
              <Button variant="ghost" onClick={openEditModal}>
                <Edit3 size={14} /> Edit
              </Button>
              <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
              <div style={{ flex: 1 }} />
              {consignment.status === 'active' && (
                <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} color="#DC2626" /> <span style={{ color: '#DC2626' }}>Delete</span>
                </Button>
              )}
            </div>
          </Card>
        )}

        {/* Item + Consignor — 2-Col Row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>

          {/* Item Card */}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Item</span>
            </div>
            <div style={{ padding: 14 }}>
              <div className="flex items-start gap-4" style={{ minWidth: 0 }}>
                {product?.images && product.images.length > 0 ? (
                  <img
                    src={product.images[0]}
                    alt={productLabel}
                    className="cursor-pointer"
                    onClick={() => product && navigate(`/collection/${product.id}`)}
                    style={{
                      width: 96, height: 96, borderRadius: 10,
                    objectFit: 'cover', flexShrink: 0,
                    border: '1px solid #E5E9EE', background: '#F2F7FA',
                  }}
                />
              ) : (
                <div
                  className={product ? 'cursor-pointer' : ''}
                  onClick={() => product && navigate(`/collection/${product.id}`)}
                  style={{
                    width: 96, height: 96, borderRadius: 10,
                    background: '#F2F7FA', border: '1px solid #E5E9EE',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                  <Package size={28} strokeWidth={1.2} style={{ color: '#9CA3AF' }} />
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                  Product
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#0F0F10', lineHeight: 1.25 }}>
                  {productLabel}
                </div>
                {product?.sku && (
                  <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 4 }}>{product.sku}</span>
                )}
                {(() => {
                  const specs = product ? getProductSpecs(product, categories, { includeSku: false }) : [];
                  if (specs.length === 0) return null;
                  return (
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      columnGap: 14, rowGap: 3,
                      marginTop: 10, fontSize: 11,
                    }}>
                      {specs.slice(0, 8).map((s, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                          <span style={{ color: '#9CA3AF' }}>{s.label}:</span>
                          <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.value}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Expiry Warning — bleibt im Item-Card als kompakter Banner */}
            {expiryWarning && (
              <div className="flex items-center gap-2" style={{
                marginTop: 14, padding: '8px 12px', borderRadius: 8,
                background: expiryDays! <= 0 ? 'rgba(220,38,38,0.08)' : 'rgba(15,15,16,0.06)',
                border: `1px solid ${expiryDays! <= 0 ? '#AA6E6E30' : '#0F0F1030'}`,
              }}>
                <AlertTriangle size={14} style={{ color: expiryDays! <= 0 ? '#AA6E6E' : '#0F0F10' }} />
                <span style={{ fontSize: 12, color: expiryDays! <= 0 ? '#AA6E6E' : '#0F0F10' }}>
                  {expiryDays! <= 0
                    ? `Expired ${Math.abs(expiryDays!)} day${Math.abs(expiryDays!) !== 1 ? 's' : ''} ago`
                    : `Expires in ${expiryDays} day${expiryDays !== 1 ? 's' : ''}`}
                </span>
              </div>
            )}
            </div>
          </Card>

          {/* Consignor Card */}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Consignor / Customer</span>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {consignor ? (
                <>
                  <button
                    onClick={() => navigate(`/consignors/${consignor.id}`)}
                    className="cursor-pointer"
                    style={{
                      background: 'none', border: 'none', padding: 0, textAlign: 'left',
                      color: '#715DE3', fontSize: 15, fontWeight: 600,
                      textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3,
                    }}
                    title="Open consignor profile"
                  >
                    {consignorName}
                  </button>
                  {consignor.company && <span style={{ fontSize: 12, color: '#4B5563' }}>{consignor.company}</span>}
                  {consignor.phone && <span style={{ fontSize: 12, color: '#4B5563' }}>Phone: {consignor.phone}</span>}
                  {consignor.email && <span style={{ fontSize: 12, color: '#4B5563' }}>Email: {consignor.email}</span>}
                  <div style={{ borderTop: '1px solid #F0F2F5', paddingTop: 8, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                    <div className="flex justify-between">
                      <span style={{ color: '#6B7280' }}>Agreement Date</span>
                      <span style={{ color: '#0F0F10' }}>{consignment.agreementDate || '—'}</span>
                    </div>
                    {consignment.expiryDate && (
                      <div className="flex justify-between">
                        <span style={{ color: '#6B7280' }}>Expiry Date</span>
                        <span style={{ color: expiryWarning ? (expiryDays! <= 0 ? '#AA6E6E' : '#0F0F10') : '#0F0F10' }}>
                          {consignment.expiryDate}
                        </span>
                      </div>
                    )}
                    {consignment.staffId && (() => {
                      const e = employees.find(x => x.id === consignment.staffId);
                      if (!e) return null;
                      return (
                        <div className="flex justify-between">
                          <span style={{ color: '#6B7280' }}>Received by</span>
                          <span
                            className="cursor-pointer"
                            onClick={() => navigate(`/employees/${e.id}`)}
                            style={{ color: '#715DE3', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                          >{e.name}{e.role ? ` · ${e.role}` : ''}</span>
                        </div>
                      );
                    })()}
                  </div>
                </>
              ) : (
                <span style={{ fontSize: 12, color: '#9CA3AF' }}>Consignor not found.</span>
              )}
            </div>
          </Card>
        </div>

        {/* Status-dependent: Sale Breakdown + Linked Records (Plan 2026-05) */}
        {(consignment.status === 'sold' || consignment.status === 'paid_out') && consignment.salePrice != null && (
          <Card style={{ padding: 14, marginBottom: 18 }}>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>Sale Breakdown</span>
            <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: '#6B7280' }}>Sale Price</span>
              <span className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}><Bhd v={consignment.salePrice}/> BHD</span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: '#6B7280' }}>
                {commissionLineLabel(consignment)}
              </span>
              <span className="font-mono" style={{ color: (consignment.commissionAmount || 0) < 0 ? '#DC2626' : '#0F0F10' }}>
                <Bhd v={consignment.commissionAmount || 0}/> BHD
              </span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 13, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <span style={{ color: '#6B7280' }}>Payout Amount</span>
              <span className="font-mono" style={{ color: '#7EAA6E', fontSize: 16 }}><Bhd v={consignment.payoutAmount || 0}/> BHD</span>
            </div>
            {buyer && (
              <div className="flex justify-between" style={{ fontSize: 13, marginTop: 8 }}>
                <span style={{ color: '#6B7280' }}>Buyer</span>
                <span style={{ color: '#0F0F10' }}>{buyer.firstName} {buyer.lastName}</span>
              </div>
            )}

            {(linkedInvoice || linkedPurchase || linkedLossExpense) && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                <span className="text-overline" style={{ marginBottom: 10, display: 'block' }}>Linked Records</span>
                {linkedInvoice && (
                  <button onClick={() => navigate(`/invoices/${linkedInvoice.id}`)}
                    className="cursor-pointer flex items-center justify-between w-full"
                    style={{
                      padding: '8px 10px', marginBottom: 6, fontSize: 12,
                      borderRadius: 6, border: '1px solid #E5E9EE', background: 'transparent',
                    }}>
                    <span className="flex items-center gap-2" style={{ color: '#0F0F10' }}>
                      <FileText size={13} style={{ color: '#715DE3' }} /> Buyer Invoice
                      <span className="font-mono" style={{ color: '#3D7FFF', marginLeft: 4 }}>{formatInvoiceDisplayShort(linkedInvoice)}</span>
                    </span>
                    <span className="font-mono" style={{ color: linkedInvoice.paidAmount >= linkedInvoice.grossAmount ? '#16A34A' : '#DC2626' }}>
                      <Bhd v={linkedInvoice.grossAmount - linkedInvoice.paidAmount}/> BHD remaining
                    </span>
                  </button>
                )}
                {linkedPurchase && (
                  <button onClick={() => navigate(`/purchases/${linkedPurchase.id}`)}
                    className="cursor-pointer flex items-center justify-between w-full"
                    style={{
                      padding: '8px 10px', marginBottom: 6, fontSize: 12,
                      borderRadius: 6, border: '1px solid #E5E9EE', background: 'transparent',
                    }}>
                    <span className="flex items-center gap-2" style={{ color: '#0F0F10' }}>
                      <ShoppingBag size={13} style={{ color: '#FF8730' }} /> Consignor Purchase
                      <span className="font-mono" style={{ color: '#3D7FFF', marginLeft: 4 }}>{linkedPurchase.purchaseNumber}</span>
                    </span>
                    <span className="font-mono" style={{ color: (linkedPurchase.paidAmount || 0) >= linkedPurchase.totalAmount ? '#16A34A' : '#FF8730' }}>
                      <Bhd v={linkedPurchase.totalAmount - (linkedPurchase.paidAmount || 0)}/> BHD owed
                    </span>
                  </button>
                )}
                {linkedLossExpense && (
                  <button onClick={() => navigate('/expenses')}
                    className="cursor-pointer flex items-center justify-between w-full"
                    style={{
                      padding: '8px 10px', fontSize: 12,
                      borderRadius: 6, border: '1px solid rgba(220,38,38,0.20)', background: 'rgba(220,38,38,0.04)',
                    }}>
                    <span className="flex items-center gap-2" style={{ color: '#DC2626' }}>
                      <Receipt size={13} /> Consignor Loss Expense
                      <span className="font-mono" style={{ marginLeft: 4 }}>{linkedLossExpense.expenseNumber}</span>
                    </span>
                    <span className="font-mono" style={{ color: '#DC2626' }}><Bhd v={linkedLossExpense.amount}/> BHD</span>
                  </button>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Payout Details (paid_out) */}
        {consignment.status === 'paid_out' && (
          <Card style={{ padding: 14, marginBottom: 18 }}>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>Payout Details</span>
            <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: '#6B7280' }}>Status</span>
              <StatusDot status={consignment.payoutStatus} />
            </div>
            {consignment.payoutMethod && (
              <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: '#6B7280' }}>Method</span>
                <span style={{ color: '#0F0F10' }}>{consignment.payoutMethod === 'bank_transfer' ? 'Bank Transfer' : consignment.payoutMethod === 'cash' ? 'Cash' : consignment.payoutMethod === 'benefit' ? 'Benefit' : 'Card'}</span>
              </div>
            )}
            {consignment.payoutDate && (
              <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: '#6B7280' }}>Date</span>
                <span style={{ color: '#0F0F10' }}>{consignment.payoutDate}</span>
              </div>
            )}
            {consignment.payoutReference && (
              <div className="flex justify-between" style={{ fontSize: 13 }}>
                <span style={{ color: '#6B7280' }}>Reference</span>
                <span className="font-mono" style={{ color: '#4B5563' }}>{consignment.payoutReference}</span>
              </div>
            )}
          </Card>
        )}

        {/* Active: Expected Payout Preview — SSOT-Projektion zum Agreed/Cost-Preis.
            cost_split @ Kost = Breakeven (Marge 0, Payout = Kost). */}
        {consignment.status === 'active' && (() => {
          const proj = computeConsignmentSale(consignment, consignment.agreedPrice);
          const isCostSplit = consignment.commissionType === 'cost_split';
          return (
            <Card style={{ padding: 14, marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>
                {isCostSplit ? 'If Sold at Cost (Breakeven)' : 'If Sold at Agreed Price'}
              </div>
              <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: '#6B7280' }}>
                  {commissionLineLabel(consignment)}
                </span>
                <span className="font-mono" style={{ color: '#0F0F10' }}>
                  <Bhd v={proj.commission}/> BHD
                </span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 13 }}>
                <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                <span className="font-mono" style={{ color: '#7EAA6E' }}>
                  <Bhd v={proj.payout}/> BHD
                </span>
              </div>
            </Card>
          );
        })()}

        {/* Meta Footer Card — Transfer-Detail-Style: alle Detail-Felder + Notes */}
        <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <KvCell label="Consignment Number" value={consignment.consignmentNumber} mono />
            <KvCell label="Status" value={String(consignment.status).toUpperCase()} />
            <KvCell label="Payout Status" value={String(consignment.payoutStatus || 'pending').toUpperCase()} />
            <KvCell label="Agreed Price"
              value={<><Bhd v={consignment.agreedPrice}/> BHD</>} />
            <KvCell label="Minimum Price"
              value={consignment.minimumPrice != null ? <><Bhd v={consignment.minimumPrice}/> BHD</> : '—'} />
            <KvCell label="Commission"
              value={commissionModelLabel(consignment)} />
          </div>
          {consignment.notes && (
            <div style={{ borderTop: '1px solid #F0F2F5', paddingTop: 10 }}>
              <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                Notes
              </div>
              <p style={{ fontSize: 13, color: '#0F0F10', whiteSpace: 'pre-wrap', margin: 0 }}>{consignment.notes}</p>
            </div>
          )}
        </Card>

      </div>

      {/* ── Record Sale Modal (Plan 2026-05) ── */}
      <Modal open={soldModal} onClose={() => setSoldModal(false)} title="Record Sale" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SearchSelect
            label="BUYER"
            placeholder="Search clients..."
            options={customers.map(c => ({ id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone }))}
            value={soldBuyer}
            onChange={id => setSoldBuyer(id)}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Input required label="SALE PRICE (BHD)" type="number" placeholder="0"
              value={soldPrice}
              onChange={e => { setSoldPrice(e.target.value); setSoldAck(false); }} />
            <Input label="SALE DATE" type="date"
              value={soldDate}
              onChange={e => setSoldDate(e.target.value)} />
          </div>
          {salePriceNum > 0 && (
            <div className="rounded font-mono" style={{
              padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
            }}>
              <div className="flex justify-between" style={{ marginBottom: 8 }}>
                <span style={{ color: '#6B7280' }}>
                  {commissionLineLabel(consignment)}
                </span>
                <span style={{ color: saleCommission < 0 ? '#DC2626' : '#0F0F10' }}><Bhd v={saleCommission}/> BHD</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: '#6B7280' }}>Payout to consignor</span>
                <span style={{ color: '#7EAA6E' }}><Bhd v={salePayout}/> BHD</span>
              </div>
            </div>
          )}
          {buyerIsConsignor && (
            <div style={{
              padding: '12px 14px', borderRadius: 8,
              background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.40)',
              fontSize: 12, color: '#DC2626',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Buyer cannot be the same as the consignor</div>
              <div style={{ color: '#7A2A2A' }}>
                If the consignor is taking the item back, use <strong>Return</strong> instead — no invoice/purchase needed.
              </div>
            </div>
          )}
          {saleNeedsAck && (
            <div style={{
              padding: '12px 14px', borderRadius: 8,
              background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.30)',
              fontSize: 12, color: '#DC2626',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                ⚠ Sale <Bhd v={saleShortfall}/> BHD below {consignment.commissionType === 'cost_split' ? "consignor's cost" : 'agreed price'}
              </div>
              <div style={{ marginBottom: 10, color: '#7A2A2A' }}>
                Consignor still receives <Bhd v={consignment.agreedPrice}/> BHD —
                the <Bhd v={saleShortfall}/> BHD difference will be recorded as a <strong>Consignor Loss</strong> expense.
              </div>
              <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={soldAck} onChange={e => setSoldAck(e.target.checked)} />
                <span>I confirm — record this shortfall as Consignor Loss</span>
              </label>
            </div>
          )}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea
              placeholder="Reference, payment terms, …"
              value={soldNotes}
              onChange={e => setSoldNotes(e.target.value)}
              className="w-full"
              style={{
                background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6,
                padding: '8px 10px', fontSize: 13, color: '#0F0F10', resize: 'vertical', minHeight: 50,
              }}
            />
          </div>
          <div style={{
            padding: '10px 12px', borderRadius: 6, background: '#F2F7FA',
            border: '1px solid #E5E9EE', fontSize: 11, color: '#6B7280', lineHeight: 1.4,
          }}>
            On save: <strong>Auto-Invoice</strong> for buyer · <strong>Auto-Purchase</strong> for consignor (as supplier).
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setSoldModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleRecordSale}
              disabled={!soldPrice || !soldBuyer || buyerIsConsignor || (saleNeedsAck && !soldAck)}
            >Confirm Sale</Button>
          </div>
        </div>
      </Modal>

      <NumberTypeDialog
        open={numberDialogOpen}
        variant="sales"
        onCancel={() => setNumberDialogOpen(false)}
        onConfirm={executeRecordSale}
      />

      {/* ── Pay Out Modal ── */}
      <Modal open={paidModal} onClose={() => setPaidModal(false)} title="Pay Out Consignor" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="rounded font-mono" style={{
            padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
          }}>
            <div className="flex justify-between" style={{ marginBottom: 8 }}>
              <span style={{ color: '#6B7280' }}>Consignor</span>
              <span style={{ color: '#0F0F10' }}>{consignorName}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: '#6B7280' }}>Payout Amount</span>
              <span style={{ color: '#7EAA6E' }}><Bhd v={consignment.payoutAmount || 0}/> BHD</span>
            </div>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>PAYMENT METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {['bank_transfer', 'cash', 'card', 'benefit'].map(m => (
                <button key={m} onClick={() => setPaidMethod(m)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${paidMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: paidMethod === m ? '#0F0F10' : '#6B7280',
                    background: paidMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'bank_transfer' ? 'Bank Transfer' : m === 'cash' ? 'Cash' : m === 'card' ? 'Card' : 'Benefit'}</button>
              ))}
            </div>
          </div>
          <Input label="REFERENCE" placeholder="Optional reference..."
            value={paidRef}
            onChange={e => setPaidRef(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setPaidModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleMarkPaid}>Confirm Payout</Button>
          </div>
        </div>
      </Modal>

      {/* ── Return Confirmation Modal ── */}
      <Modal open={returnModal} onClose={() => setReturnModal(false)} title="Return Consignment" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Return <strong style={{ color: '#0F0F10' }}>{productLabel}</strong> to consignor <strong style={{ color: '#0F0F10' }}>{consignorName}</strong>? The product will be set back to in stock.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setReturnModal(false)}>Cancel</Button>
          <Button variant="secondary" onClick={handleReturn}>Confirm Return</Button>
        </div>
      </Modal>

      {/* ── Post-Sale Return Modal (Plan §Commission §13) ── */}
      <Modal open={postSaleReturnModal} onClose={() => setPostSaleReturnModal(false)} title="Buyer Returns the Item" width={520}>
        <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 16, lineHeight: 1.5 }}>
          The buyer is returning <strong style={{ color: '#0F0F10' }}>{productLabel}</strong>.
          What should happen with the item?
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          <button onClick={() => setPostSaleDisposition('RETURN_TO_OWNER')}
            className="cursor-pointer text-left"
            style={{
              padding: '14px 16px', borderRadius: 8,
              border: `1px solid ${postSaleDisposition === 'RETURN_TO_OWNER' ? '#0F0F10' : '#D5D9DE'}`,
              background: postSaleDisposition === 'RETURN_TO_OWNER' ? 'rgba(15,15,16,0.06)' : 'transparent',
            }}>
            <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500 }}>{'↩'} Give back to consignor</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.5 }}>
              Goods leave our system back to <strong>{consignorName}</strong>. Our A/P to him gets cancelled (we owe nothing anymore {'—'} he has his watch back). No inventory effect for us.
            </div>
          </button>
          <button onClick={() => setPostSaleDisposition('KEEP_AS_OWN')}
            className="cursor-pointer text-left"
            style={{
              padding: '14px 16px', borderRadius: 8,
              border: `1px solid ${postSaleDisposition === 'KEEP_AS_OWN' ? '#0F0F10' : '#D5D9DE'}`,
              background: postSaleDisposition === 'KEEP_AS_OWN' ? 'rgba(15,15,16,0.06)' : 'transparent',
            }}>
            <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500 }}>{'📦'} Keep in our inventory</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.5 }}>
              Item becomes our own stock. Our A/P to <strong>{consignorName}</strong> (<Bhd v={consignment.payoutAmount || 0}/> BHD) stays open {'—'} we still owe him that. Cost basis for re-sale = <Bhd v={consignment.payoutAmount || 0}/> BHD.
            </div>
          </button>
        </div>
        <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12, color: '#4B5563', marginBottom: 16 }}>
          A Credit Note + Sales Return will be created automatically to refund the buyer for the original sale.
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setPostSaleReturnModal(false)}>Cancel</Button>
          <Button variant="primary" onClick={handlePostSaleReturn}>Confirm Return</Button>
        </div>
      </Modal>

      {/* ── Cancel Sale Confirmation Modal ── */}
      <Modal open={cancelSaleModal} onClose={() => setCancelSaleModal(false)} title="Cancel Sale" width={500}>
        <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 12, lineHeight: 1.5 }}>
          This will <strong style={{ color: '#0F0F10' }}>fully reverse</strong> the sale of <strong>{productLabel}</strong>:
        </p>
        <ul style={{ fontSize: 13, color: '#4B5563', marginBottom: 16, paddingLeft: 18, lineHeight: 1.7 }}>
          {linkedInvoice && (
            <li>Buyer Invoice <span className="font-mono" style={{ color: '#3D7FFF' }}>{formatInvoiceDisplayShort(linkedInvoice)}</span> → <strong>CANCELLED</strong> (AR cleared)</li>
          )}
          {linkedInvoice && (linkedInvoice.paidAmount || 0) > 0.005 && (
            <li style={{ color: '#B45309' }}>Buyer already paid <strong><Bhd v={linkedInvoice.paidAmount}/> BHD</strong> — this is <strong>NOT auto-refunded</strong> (refund or delete the payment separately)</li>
          )}
          {linkedPurchase && (
            <li>Consignor Purchase <span className="font-mono" style={{ color: '#3D7FFF' }}>{linkedPurchase.purchaseNumber}</span> → <strong>CANCELLED</strong>{(linkedPurchase.paidAmount || 0) > 0.005 ? '' : ' (AP cleared)'}</li>
          )}
          {linkedPurchase && (linkedPurchase.paidAmount || 0) > 0.005 && (
            <li style={{ color: '#B45309' }}>Payments of <strong><Bhd v={linkedPurchase.paidAmount}/> BHD</strong> on the consignor purchase stay booked → open receivable against the consignor</li>
          )}
          {linkedLossExpense && (
            <li>Consignor-Loss-Expense <span className="font-mono" style={{ color: '#DC2626' }}>{linkedLossExpense.expenseNumber}</span> → <strong>CANCELLED</strong></li>
          )}
          {(consignment.payoutPaidAmount || 0) > 0.005 && (
            <li style={{ color: '#B45309' }}>Consignor payout of <strong><Bhd v={consignment.payoutPaidAmount || 0}/> BHD</strong>{consignment.payoutMethod ? ` (paid via ${consignment.payoutMethod})` : ''} → <strong>reversed in the books</strong></li>
          )}
          <li>Consignment <strong>{consignment.consignmentNumber}</strong> → status back to <strong>active</strong>, sale data cleared</li>
          <li>Product <strong>{productLabel}</strong> → stock_status back to <strong>consignment</strong></li>
        </ul>
        <div style={{
          padding: '10px 12px', borderRadius: 6,
          background: 'rgba(255,135,48,0.06)', border: '1px solid rgba(255,135,48,0.30)',
          fontSize: 12, color: '#7A4A20', marginBottom: 16, lineHeight: 1.5,
        }}>
          Use this when the sale was a mistake (wrong buyer, wrong price, buyer = consignor).
          For a normal post-sale return where the customer brings the item back, use <strong>Post-Sale Return</strong> instead.
          {(consignment.payoutPaidAmount || 0) > 0.005 && (
            <> The payout reversal is a <strong>booking only</strong> — cash/bank will show the money as returned,
            so make sure you actually collect <Bhd v={consignment.payoutPaidAmount || 0}/> BHD back from the consignor.</>
          )}
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setCancelSaleModal(false)}>Keep Sale</Button>
          <Button variant="danger" onClick={handleCancelSale}>Cancel Sale</Button>
        </div>
      </Modal>

      {/* ── Delete Confirmation Modal ── */}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Consignment" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete consignment <strong style={{ color: '#0F0F10' }}>{consignment.consignmentNumber}</strong> for <strong style={{ color: '#0F0F10' }}>{productLabel}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="consignments"
        entityId={consignment.id}
        title={`History · ${consignment.consignmentNumber}`}
      />

      {/* Edit Modal — ersetzt den alten Inline-Edit-Mode (2026-05-18) */}
      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit Consignment — ${consignment.consignmentNumber}`} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input required label="AGREED PRICE (BHD)" type="number" value={form.agreedPrice}
            onChange={e => setForm({ ...form, agreedPrice: e.target.value })} />
          <Input label="MINIMUM PRICE (BHD)" type="number" placeholder="Optional" value={form.minimumPrice}
            onChange={e => setForm({ ...form, minimumPrice: e.target.value })} />
          <Input required label="COMMISSION RATE (%)" type="number" value={form.commissionRate}
            onChange={e => setForm({ ...form, commissionRate: e.target.value })} />
          <Input label="EXPIRY DATE" type="date" value={form.expiryDate}
            onChange={e => setForm({ ...form, expiryDate: e.target.value })} />

          {editAgreed > 0 && editRate > 0 && (
            <div className="rounded font-mono" style={{
              padding: 12, background: '#F2F7FA',
              border: '1px solid #E5E9EE', fontSize: 12,
            }}>
              <div style={{ marginBottom: 4, color: '#6B7280', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                If Sold at Agreed Price
              </div>
              <div className="flex justify-between" style={{ marginTop: 8 }}>
                <span style={{ color: '#6B7280' }}>Commission ({fmtPct(editRate)}%)</span>
                <span style={{ color: '#0F0F10' }}><Bhd v={editCommission}/> BHD</span>
              </div>
              <div className="flex justify-between" style={{ marginTop: 6 }}>
                <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                <span style={{ color: '#7EAA6E' }}><Bhd v={editPayout}/> BHD</span>
              </div>
            </div>
          )}

          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }}
            />
          </div>

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function KvCell({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
        {label}
      </div>
      <div className={mono ? 'font-mono' : ''} style={{ fontSize: 13, color: '#0F0F10' }}>{value}</div>
    </div>
  );
}
