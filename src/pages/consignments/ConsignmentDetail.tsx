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

function fmt(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

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

  // Sale modal calculations (Plan 2026-05 §Consignment-Refactor)
  const salePriceNum = Number(soldPrice) || 0;
  const isAgreedExcess = consignment.commissionType === 'consignor_fixed';
  let saleCommission: number; let salePayout: number;
  if (isAgreedExcess) {
    salePayout = consignment.agreedPrice;          // Garantie
    saleCommission = salePriceNum - consignment.agreedPrice;  // kann negativ sein = Loss
  } else {
    saleCommission = salePriceNum * (consignment.commissionRate / 100);
    salePayout = salePriceNum - saleCommission;
  }
  const saleNeedsAck = isAgreedExcess && salePriceNum > 0 && salePriceNum < consignment.agreedPrice;
  const saleShortfall = saleNeedsAck ? consignment.agreedPrice - salePriceNum : 0;
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

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={goBack}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ agreedPrice: String(consignment.agreedPrice), minimumPrice: consignment.minimumPrice != null ? String(consignment.minimumPrice) : '', commissionRate: String(consignment.commissionRate), expiryDate: consignment.expiryDate || '', notes: consignment.notes || '' }); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                {consignment.status === 'active' && perm.canManageConsignments && (
                  <>
                    <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>
                    <Button variant="primary" onClick={() => {
                      setSoldPrice(String(consignment.agreedPrice || ''));
                      setSoldBuyer('');
                      setSoldDate(new Date().toISOString().split('T')[0]);
                      setSoldNotes('');
                      setSoldAck(false);
                      setSoldModal(true);
                    }}>Record Sale</Button>
                    <Button variant="ghost" onClick={() => setReturnModal(true)}>Return</Button>
                  </>
                )}
                {consignment.status === 'sold' && perm.canManageConsignments && (
                  <>
                    {/* Plan 2026-05: Bezahlung läuft jetzt über die linked Invoice/Purchase.
                        Pay-Out-Button nur noch für Legacy-Consignments (kein invoiceId). */}
                    {!consignment.invoiceId && (
                      <Button variant="primary" onClick={() => setPaidModal(true)}>Pay Out (legacy)</Button>
                    )}
                    {consignment.invoiceId && linkedInvoice && (
                      <Button variant="primary" onClick={() => navigate(`/invoices/${consignment.invoiceId}`)}>
                        <FileText size={14} /> Buyer Invoice
                      </Button>
                    )}
                    {linkedPurchase && (
                      <Button variant="secondary" onClick={() => navigate(`/purchases/${linkedPurchase.id}`)}>
                        <ShoppingBag size={14} /> Consignor Purchase
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setPostSaleReturnModal(true)}>Post-Sale Return</Button>
                    {/* Cancel Sale: nur für neuen Flow (mit invoiceId). Reverst alle 3 Records. */}
                    {consignment.invoiceId && (
                      <Button variant="ghost" onClick={() => setCancelSaleModal(true)}>Cancel Sale</Button>
                    )}
                  </>
                )}
                {/* Post-Sale-Return ist schon gelaufen, aber noch ungereinigte Auto-Records:
                    Cancel-Sale erlaubt jetzt ein nachträgliches Cleanup auch im 'returned'-State. */}
                {consignment.status === 'returned' && consignment.invoiceId && perm.canManageConsignments && (
                  <Button variant="ghost" onClick={() => setCancelSaleModal(true)}>Cancel Sale (cleanup)</Button>
                )}
                {consignment.status === 'paid_out' && perm.canManageConsignments && (
                  <Button variant="ghost" onClick={() => setPostSaleReturnModal(true)}>Post-Sale Return</Button>
                )}
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
              </>
            )}
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>

          {/* Key Info */}
          <div>
            {/* Image + Title side-by-side */}
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
                <span className="text-overline font-mono">{consignment.consignmentNumber}</span>
                <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>
                  {productLabel}
                </h1>
                {product?.sku && (
                  <span className="font-mono" style={{ fontSize: 12, color: '#4B5563', display: 'block', marginTop: 6 }}>{product.sku}</span>
                )}
                <div className="flex items-center gap-3" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                  <StatusDot status={consignment.status} />
                  {consignment.payoutStatus !== 'pending' && consignment.status !== 'active' && (
                    <StatusDot status={consignment.payoutStatus} label={`Payout: ${consignment.payoutStatus.replace(/_/g, ' ')}`} />
                  )}
                </div>
              </div>
            </div>

            {(() => {
              // Specs-Grid (Item Type, Color, Karat, Size, Condition, ...) — damit
              // sofort sichtbar ist WAS in Consignment ist (nicht nur Brand+Name).
              // SKU wird oben unter dem Titel separat angezeigt — hier ausblenden.
              const specs = product ? getProductSpecs(product, categories, { includeSku: false }) : [];
              if (specs.length === 0) return null;
              return (
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  columnGap: 16, rowGap: 4,
                  marginTop: 14, fontSize: 11,
                }}>
                  {specs.map((s, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                      <span style={{ color: '#9CA3AF' }}>{s.label}:</span>
                      <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.value}</span>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Expiry Warning */}
            {expiryWarning && (
              <div className="flex items-center gap-2" style={{
                marginTop: 16, padding: '10px 14px', borderRadius: 8,
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

            {/* Consignor + Dates – combined meta box */}
            <div style={{ marginTop: 18, padding: '14px 16px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                <div className="flex justify-between items-start">
                  <span style={{ color: '#6B7280' }}>Consignor</span>
                  <div style={{ textAlign: 'right' }}>
                    {consignor ? (
                      <span
                        className="cursor-pointer"
                        onClick={() => navigate(`/clients/${consignor.id}`)}
                        style={{ color: '#3D7FFF', textDecoration: 'underline' }}
                      >{consignorName}</span>
                    ) : (
                      <span style={{ color: '#0F0F10' }}>{consignorName}</span>
                    )}
                    {consignor?.company && (
                      <span style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>{consignor.company}</span>
                    )}
                  </div>
                </div>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Agreement Date</span><span style={{ color: '#0F0F10' }}>{consignment.agreementDate}</span></div>
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
                      <span style={{ color: '#6B7280' }}>Staff</span>
                      <span
                        className="cursor-pointer"
                        onClick={() => navigate(`/employees/${e.id}`)}
                        style={{ color: '#3D7FFF', textDecoration: 'underline' }}
                      >{e.name}{e.role ? ` · ${e.role}` : ''}</span>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Pricing */}
          <div>
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Input required label="AGREED PRICE (BHD)" type="number" value={form.agreedPrice}
                  onChange={e => setForm({ ...form, agreedPrice: e.target.value })} />
                <Input label="MINIMUM PRICE (BHD)" type="number" placeholder="Optional" value={form.minimumPrice}
                  onChange={e => setForm({ ...form, minimumPrice: e.target.value })} />
                <Input required label="COMMISSION RATE (%)" type="number" value={form.commissionRate}
                  onChange={e => setForm({ ...form, commissionRate: e.target.value })} />
                <Input label="EXPIRY DATE" type="date" value={form.expiryDate}
                  onChange={e => setForm({ ...form, expiryDate: e.target.value })} />

                {/* Live calculation */}
                {editAgreed > 0 && editRate > 0 && (
                  <div className="rounded font-mono" style={{
                    marginTop: 8, padding: 16, background: '#F2F7FA',
                    border: '1px solid #E5E9EE', fontSize: 13,
                  }}>
                    <div style={{ marginBottom: 4, color: '#6B7280', fontSize: 11, letterSpacing: '0.04em' }}>
                      IF SOLD AT AGREED PRICE
                    </div>
                    <div className="flex justify-between" style={{ marginTop: 10 }}>
                      <span style={{ color: '#6B7280' }}>Commission ({fmtPct(editRate)}%)</span>
                      <span style={{ color: '#0F0F10' }}><Bhd v={editCommission}/> BHD</span>
                    </div>
                    <div className="flex justify-between" style={{ marginTop: 8 }}>
                      <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                      <span style={{ color: '#7EAA6E' }}><Bhd v={editPayout}/> BHD</span>
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 8 }}>
                  <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                  <textarea
                    value={form.notes}
                    onChange={e => setForm({ ...form, notes: e.target.value })}
                    className="w-full outline-none transition-colors duration-300"
                    rows={3}
                    style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                  />
                </div>
              </div>
            ) : (
              <>
                {/* Agreed / Minimum */}
                <div style={{ marginBottom: 20 }}>
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">AGREED PRICE</span>
                    <span className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}><Bhd v={consignment.agreedPrice}/> BHD</span>
                  </div>
                  {consignment.minimumPrice != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">MINIMUM PRICE</span>
                      <span className="font-display" style={{ fontSize: 18, color: '#4B5563' }}><Bhd v={consignment.minimumPrice}/> BHD</span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">COMMISSION RATE</span>
                    <span className="font-mono" style={{ fontSize: 18, color: '#0F0F10' }}>{fmtPct(consignment.commissionRate)}%</span>
                  </div>
                </div>

                {/* If sold: sale breakdown */}
                {(consignment.status === 'sold' || consignment.status === 'paid_out') && consignment.salePrice != null && (
                  <div style={{ padding: '16px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE', marginBottom: 20 }}>
                    <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 12 }}>Sale Breakdown</span>
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span style={{ fontSize: 13, color: '#6B7280' }}>Sale Price</span>
                      <span className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}><Bhd v={consignment.salePrice}/> BHD</span>
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                      <span style={{ color: '#6B7280' }}>
                        {isAgreedExcess ? `Our margin (above agreed)` : `Commission (${fmtPct(consignment.commissionRate)}%)`}
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

                    {/* Linked Records — Plan 2026-05: Sold-Flow erzeugt Invoice + Purchase
                        (+ optional Consignor-Loss-Expense). Click-Through für Bezahlung. */}
                    {(linkedInvoice || linkedPurchase || linkedLossExpense) && (
                      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                        <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 10 }}>Linked Records</span>
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
                  </div>
                )}

                {/* Payout info (if paid out) */}
                {consignment.status === 'paid_out' && (
                  <div style={{ padding: '16px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE', marginBottom: 20 }}>
                    <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 12 }}>Payout Details</span>
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
                  </div>
                )}

                {/* Expected payout (active) */}
                {consignment.status === 'active' && (
                  <div className="rounded font-mono" style={{
                    padding: 16, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
                  }}>
                    <div style={{ marginBottom: 4, color: '#6B7280', fontSize: 11, letterSpacing: '0.04em' }}>
                      IF SOLD AT AGREED PRICE
                    </div>
                    <div className="flex justify-between" style={{ marginTop: 10 }}>
                      <span style={{ color: '#6B7280' }}>
                        {isAgreedExcess ? 'Our margin (excess above agreed)' : `Commission (${fmtPct(consignment.commissionRate)}%)`}
                      </span>
                      <span style={{ color: '#0F0F10' }}>
                        <Bhd v={isAgreedExcess ? 0 : consignment.agreedPrice * (consignment.commissionRate / 100)}/> BHD
                      </span>
                    </div>
                    <div className="flex justify-between" style={{ marginTop: 8 }}>
                      <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                      <span style={{ color: '#7EAA6E' }}>
                        <Bhd v={isAgreedExcess ? consignment.agreedPrice : consignment.agreedPrice - consignment.agreedPrice * (consignment.commissionRate / 100)}/> BHD
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Internal Notes — schlank, nur was nicht schon im Hero steht */}
        {(consignment.notes || (consignment.status === 'active' && editing && perm.canManageConsignments)) && (
          <Card>
            {consignment.notes && (
              <>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>NOTES</span>
                <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' }}>{consignment.notes}</p>
              </>
            )}
            {consignment.status === 'active' && editing && perm.canManageConsignments && (
              <div className="flex gap-2" style={{ marginTop: consignment.notes ? 20 : 0 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Consignment
                </Button>
              </div>
            )}
          </Card>
        )}
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
                  {isAgreedExcess ? `Our margin (above agreed ${fmt(consignment.agreedPrice)})` : `Commission (${fmtPct(consignment.commissionRate)}%)`}
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
                ⚠ Sale <Bhd v={saleShortfall}/> BHD below agreed price
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
      <Modal open={postSaleReturnModal} onClose={() => setPostSaleReturnModal(false)} title="Post-Sale Return" width={500}>
        <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 16, lineHeight: 1.5 }}>
          Plan §Commission §13: Der Endkunde bringt <strong style={{ color: '#0F0F10' }}>{productLabel}</strong> zurück.
          Wähle die Disposition:
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          <button onClick={() => setPostSaleDisposition('RETURN_TO_OWNER')}
            className="cursor-pointer text-left"
            style={{
              padding: '14px 16px', borderRadius: 8,
              border: `1px solid ${postSaleDisposition === 'RETURN_TO_OWNER' ? '#0F0F10' : '#D5D9DE'}`,
              background: postSaleDisposition === 'RETURN_TO_OWNER' ? 'rgba(15,15,16,0.06)' : 'transparent',
            }}>
            <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500 }}>A · Return to Owner</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Ware verlässt dein System. Produkt = RETURNED, Consignment = RETURNED_TO_OWNER.</div>
          </button>
          <button onClick={() => setPostSaleDisposition('KEEP_AS_OWN')}
            className="cursor-pointer text-left"
            style={{
              padding: '14px 16px', borderRadius: 8,
              border: `1px solid ${postSaleDisposition === 'KEEP_AS_OWN' ? '#0F0F10' : '#D5D9DE'}`,
              background: postSaleDisposition === 'KEEP_AS_OWN' ? 'rgba(15,15,16,0.06)' : 'transparent',
            }}>
            <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500 }}>B · Keep as Own</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Bleibt bei dir. source_type → OWN, purchase_price = sale_price (<Bhd v={consignment.salePrice || 0}/> BHD).</div>
          </button>
        </div>
        <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12, color: '#4B5563', marginBottom: 16 }}>
          Ein Sales Return (RET) wird automatisch für die Invoice {consignment.invoiceId ? `${consignment.invoiceId.slice(0, 8)}...` : '\u2014'} erzeugt. VAT + Paid-Amount werden korrigiert.
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
          {linkedPurchase && (
            <li>Consignor Purchase <span className="font-mono" style={{ color: '#3D7FFF' }}>{linkedPurchase.purchaseNumber}</span> → <strong>CANCELLED</strong> (AP cleared)</li>
          )}
          {linkedLossExpense && (
            <li>Consignor-Loss-Expense <span className="font-mono" style={{ color: '#DC2626' }}>{linkedLossExpense.expenseNumber}</span> → <strong>CANCELLED</strong></li>
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
    </div>
  );
}
