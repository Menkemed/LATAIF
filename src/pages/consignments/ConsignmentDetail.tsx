import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Save, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { usePermission } from '@/hooks/usePermission';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtPct(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
  const {
    consignments, loadConsignments, updateConsignment,
    markSold, markPaidOut, markReturned, markReturnedAfterSale, deleteConsignment,
  } = useConsignmentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts } = useProductStore();

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
  const [paidModal, setPaidModal] = useState(false);
  const [paidMethod, setPaidMethod] = useState('bank_transfer');
  const [paidRef, setPaidRef] = useState('');
  const [returnModal, setReturnModal] = useState(false);
  const [postSaleReturnModal, setPostSaleReturnModal] = useState(false);
  const [postSaleDisposition, setPostSaleDisposition] = useState<'RETURN_TO_OWNER' | 'KEEP_AS_OWN'>('RETURN_TO_OWNER');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const perm = usePermission();

  useEffect(() => {
    loadConsignments();
    loadCustomers();
    loadProducts();
  }, [loadConsignments, loadCustomers, loadProducts]);

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

  // Sale modal calculations
  const salePriceNum = Number(soldPrice) || 0;
  const saleCommission = salePriceNum * (consignment.commissionRate / 100);
  const salePayout = salePriceNum - saleCommission;

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

  function handleMarkSold() {
    if (!id || !soldPrice) return;
    markSold(id, Number(soldPrice), soldBuyer || undefined);
    setSoldModal(false);
    setSoldPrice('');
    setSoldBuyer('');
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

  function handleDelete() {
    if (!id) return;
    deleteConsignment(id);
    navigate('/consignments');
  }

  function renderField(label: string, value: React.ReactNode) {
    return (
      <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
        <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
        <span style={{ fontSize: 13, color: '#0F0F10' }}>{value || '\u2014'}</span>
      </div>
    );
  }

  const consignorName = consignor
    ? `${consignor.firstName} ${consignor.lastName}`
    : '\u2014';

  const productLabel = product
    ? `${product.brand} ${product.name}`
    : '\u2014';

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/consignments')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Consignments
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
                    <Button variant="primary" onClick={() => { setSoldPrice(String(consignment.agreedPrice)); setSoldModal(true); }}>Mark as Sold</Button>
                    <Button variant="ghost" onClick={() => setReturnModal(true)}>Return</Button>
                  </>
                )}
                {consignment.status === 'sold' && perm.canManageConsignments && (
                  <>
                    <Button variant="primary" onClick={() => setPaidModal(true)}>Pay Out</Button>
                    <Button variant="ghost" onClick={() => setPostSaleReturnModal(true)}>Post-Sale Return</Button>
                  </>
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
            <span className="text-overline">{consignment.consignmentNumber}</span>
            <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>
              {productLabel}
            </h1>
            {product?.sku && (
              <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 8 }}>{product.sku}</span>
            )}
            <div className="flex items-center gap-4" style={{ marginTop: 12 }}>
              <StatusDot status={consignment.status} />
              {consignment.payoutStatus !== 'pending' && consignment.status !== 'active' && (
                <StatusDot status={consignment.payoutStatus} label={`Payout: ${consignment.payoutStatus.replace(/_/g, ' ')}`} />
              )}
            </div>

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

            {/* Consignor */}
            <div style={{ marginTop: 24, padding: '14px 16px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Consignor</span>
              <span style={{ fontSize: 15, color: '#0F0F10', display: 'block', marginTop: 4 }}>{consignorName}</span>
              {consignor?.company && (
                <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginTop: 2 }}>{consignor.company}</span>
              )}
            </div>

            {/* Dates */}
            <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div className="flex justify-between" style={{ fontSize: 12 }}>
                <span style={{ color: '#6B7280' }}>Agreement Date</span>
                <span style={{ color: '#0F0F10' }}>{consignment.agreementDate}</span>
              </div>
              {consignment.expiryDate && (
                <div className="flex justify-between" style={{ fontSize: 12, marginTop: 6 }}>
                  <span style={{ color: '#6B7280' }}>Expiry Date</span>
                  <span style={{ color: expiryWarning ? (expiryDays! <= 0 ? '#AA6E6E' : '#0F0F10') : '#0F0F10' }}>
                    {consignment.expiryDate}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Pricing */}
          <div>
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Input label="AGREED PRICE (BHD)" type="number" value={form.agreedPrice}
                  onChange={e => setForm({ ...form, agreedPrice: e.target.value })} />
                <Input label="MINIMUM PRICE (BHD)" type="number" placeholder="Optional" value={form.minimumPrice}
                  onChange={e => setForm({ ...form, minimumPrice: e.target.value })} />
                <Input label="COMMISSION RATE (%)" type="number" value={form.commissionRate}
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
                      <span style={{ color: '#0F0F10' }}>{fmt(editCommission)} BHD</span>
                    </div>
                    <div className="flex justify-between" style={{ marginTop: 8 }}>
                      <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                      <span style={{ color: '#7EAA6E' }}>{fmt(editPayout)} BHD</span>
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
                    <span className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}>{fmt(consignment.agreedPrice)} BHD</span>
                  </div>
                  {consignment.minimumPrice != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">MINIMUM PRICE</span>
                      <span className="font-display" style={{ fontSize: 18, color: '#4B5563' }}>{fmt(consignment.minimumPrice)} BHD</span>
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
                      <span className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}>{fmt(consignment.salePrice)} BHD</span>
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                      <span style={{ color: '#6B7280' }}>Commission ({fmtPct(consignment.commissionRate)}%)</span>
                      <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(consignment.commissionAmount || 0)} BHD</span>
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 13, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
                      <span style={{ color: '#6B7280' }}>Payout Amount</span>
                      <span className="font-mono" style={{ color: '#7EAA6E', fontSize: 16 }}>{fmt(consignment.payoutAmount || 0)} BHD</span>
                    </div>
                    {buyer && (
                      <div className="flex justify-between" style={{ fontSize: 13, marginTop: 8 }}>
                        <span style={{ color: '#6B7280' }}>Buyer</span>
                        <span style={{ color: '#0F0F10' }}>{buyer.firstName} {buyer.lastName}</span>
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
                        <span style={{ color: '#0F0F10' }}>{consignment.payoutMethod === 'bank_transfer' ? 'Bank Transfer' : consignment.payoutMethod === 'cash' ? 'Cash' : 'Card'}</span>
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
                      <span style={{ color: '#6B7280' }}>Commission ({fmtPct(consignment.commissionRate)}%)</span>
                      <span style={{ color: '#0F0F10' }}>{fmt(consignment.agreedPrice * (consignment.commissionRate / 100))} BHD</span>
                    </div>
                    <div className="flex justify-between" style={{ marginTop: 8 }}>
                      <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                      <span style={{ color: '#7EAA6E' }}>{fmt(consignment.agreedPrice - consignment.agreedPrice * (consignment.commissionRate / 100))} BHD</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Details Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Product Info */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>PRODUCT</span>
            <div style={{ marginTop: 16 }}>
              {renderField('Brand', product?.brand)}
              {renderField('Name', product?.name)}
              {renderField('SKU', product?.sku)}
              {renderField('Stock Status', product?.stockStatus ? product.stockStatus.replace(/_/g, ' ') : undefined)}
              {product?.condition && renderField('Condition', product.condition)}
            </div>
          </Card>

          {/* Consignment Details */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>DETAILS</span>
            <div style={{ marginTop: 16 }}>
              {renderField('Number', <span className="font-mono">{consignment.consignmentNumber}</span>)}
              {renderField('Status', <StatusDot status={consignment.status} />)}
              {renderField('Agreement Date', consignment.agreementDate)}
              {consignment.expiryDate && renderField('Expiry Date', consignment.expiryDate)}
              {renderField('Payout Status', <StatusDot status={consignment.payoutStatus} />)}
              {consignment.invoiceId && renderField('Invoice', <span className="font-mono">{consignment.invoiceId}</span>)}
              {consignment.notes && (
                <div style={{ marginTop: 16 }}>
                  <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                  <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{consignment.notes}</p>
                </div>
              )}
            </div>

            {/* Delete button (only active, only in edit mode) */}
            {consignment.status === 'active' && editing && perm.canManageConsignments && (
              <div className="flex gap-2" style={{ marginTop: 20 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Consignment
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* ── Mark as Sold Modal ── */}
      <Modal open={soldModal} onClose={() => setSoldModal(false)} title="Mark as Sold" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Input label="SALE PRICE (BHD)" type="number" placeholder="0"
            value={soldPrice}
            onChange={e => setSoldPrice(e.target.value)} />
          <Input label="BUYER (OPTIONAL)" placeholder="Customer ID or name..."
            value={soldBuyer}
            onChange={e => setSoldBuyer(e.target.value)} />
          {salePriceNum > 0 && (
            <div className="rounded font-mono" style={{
              padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
            }}>
              <div className="flex justify-between" style={{ marginBottom: 8 }}>
                <span style={{ color: '#6B7280' }}>Commission ({fmtPct(consignment.commissionRate)}%)</span>
                <span style={{ color: '#0F0F10' }}>{fmt(saleCommission)} BHD</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: '#6B7280' }}>Payout</span>
                <span style={{ color: '#7EAA6E' }}>{fmt(salePayout)} BHD</span>
              </div>
              {consignment.minimumPrice != null && salePriceNum < consignment.minimumPrice && (
                <div className="flex items-center gap-2" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
                  <AlertTriangle size={12} style={{ color: '#AA6E6E' }} />
                  <span style={{ fontSize: 11, color: '#AA6E6E' }}>Below minimum price of {fmt(consignment.minimumPrice)} BHD</span>
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3" style={{ paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setSoldModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleMarkSold} disabled={!soldPrice}>Confirm Sale</Button>
          </div>
        </div>
      </Modal>

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
              <span style={{ color: '#7EAA6E' }}>{fmt(consignment.payoutAmount || 0)} BHD</span>
            </div>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>PAYMENT METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {['bank_transfer', 'cash', 'card'].map(m => (
                <button key={m} onClick={() => setPaidMethod(m)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${paidMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: paidMethod === m ? '#0F0F10' : '#6B7280',
                    background: paidMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'bank_transfer' ? 'Bank Transfer' : m === 'cash' ? 'Cash' : 'Card'}</button>
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
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>Bleibt bei dir. source_type → OWN, purchase_price = sale_price ({fmt(consignment.salePrice || 0)} BHD).</div>
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
