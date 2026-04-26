import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { ConsignmentStatus } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtPct(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

type StatusFilter = '' | ConsignmentStatus;

export function ConsignmentList() {
  const navigate = useNavigate();
  const {
    consignments, loadConsignments, createConsignment,
    markSold, markPaidOut, markReturned,
  } = useConsignmentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts } = useProductStore();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [showNew, setShowNew] = useState(false);
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [commissionType, setCommissionType] = useState<'percent' | 'fixed' | 'consignor_fixed'>('percent');
  const [soldSaleMethod, setSoldSaleMethod] = useState<'cash' | 'bank'>('cash');

  // Quick-action modals
  const [soldModal, setSoldModal] = useState<string | null>(null);
  const [soldPrice, setSoldPrice] = useState('');
  const [paidModal, setPaidModal] = useState<string | null>(null);
  const [paidMethod, setPaidMethod] = useState('bank_transfer');
  const [paidRef, setPaidRef] = useState('');

  // New consignment form
  const [form, setForm] = useState({
    consignorId: '',
    productId: '',
    agreedPrice: '',
    minimumPrice: '',
    commissionRate: '15',
    expiryDate: '',
    notes: '',
    consignorSearch: '',
    productSearch: '',
  });

  useEffect(() => {
    loadConsignments();
    loadCustomers();
    loadProducts();
  }, [loadConsignments, loadCustomers, loadProducts]);

  // Lookup helpers
  const getCustomer = (id: string) => customers.find(c => c.id === id);
  const getProduct = (id: string) => products.find(p => p.id === id);

  // Filter consignments
  const filtered = useMemo(() => {
    let r = consignments;
    if (statusFilter) r = r.filter(c => c.status === statusFilter);
    if (search) {
      r = r.filter(c => matchesDeep(c, search, [getCustomer(c.consignorId), getProduct(c.productId)]));
    }
    return r;
  }, [consignments, statusFilter, search, customers, products]);

  // Stats
  const activeCount = consignments.filter(c => c.status === 'active').length;
  const totalAgreed = consignments
    .filter(c => c.status === 'active')
    .reduce((s, c) => s + c.agreedPrice, 0);

  // Plan §Commission §8: offene Auszahlungen an Besitzer.
  const outstandingPayouts = useMemo(() => {
    return consignments
      .filter(c => c.status === 'sold' && c.payoutStatus !== 'paid')
      .reduce((s, c) => s + (c.payoutAmount || 0), 0);
  }, [consignments]);
  const outstandingCount = useMemo(() =>
    consignments.filter(c => c.status === 'sold' && c.payoutStatus !== 'paid').length
  , [consignments]);


  // Live calculation
  const agreedNum = Number(form.agreedPrice) || 0;
  const rateNum = Number(form.commissionRate) || 0;
  let commission: number; let payout: number;
  if (commissionType === 'consignor_fixed') {
    payout = rateNum;
    commission = Math.max(0, agreedNum - payout);
  } else if (commissionType === 'fixed') {
    commission = rateNum;
    payout = agreedNum - commission;
  } else {
    commission = agreedNum * (rateNum / 100);
    payout = agreedNum - commission;
  }

  function openNew() {
    setForm({
      consignorId: '', productId: '',
      agreedPrice: '', minimumPrice: '', commissionRate: '15',
      expiryDate: '', notes: '', consignorSearch: '', productSearch: '',
    });
    setShowNew(true);
  }

  function handleCreate() {
    if (!form.consignorId || !form.productId) return;
    const rateVal = Number(form.commissionRate) || 0;
    createConsignment({
      consignorId: form.consignorId,
      productId: form.productId,
      agreedPrice: form.agreedPrice ? Number(form.agreedPrice) : 0,
      minimumPrice: form.minimumPrice ? Number(form.minimumPrice) : undefined,
      commissionType,
      commissionValue: rateVal,
      commissionRate: commissionType === 'percent' ? rateVal : 0,
      expiryDate: form.expiryDate || undefined,
      notes: form.notes || undefined,
    });
    setShowNew(false);
  }

  function handleMarkSold() {
    if (!soldModal || !soldPrice) return;
    markSold(soldModal, Number(soldPrice), undefined, soldSaleMethod);
    setSoldModal(null);
    setSoldPrice('');
  }

  function handleMarkPaid() {
    if (!paidModal) return;
    markPaidOut(paidModal, paidMethod, paidRef || undefined);
    setPaidModal(null);
    setPaidMethod('bank_transfer');
    setPaidRef('');
  }

  const statusFilters: { value: StatusFilter; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'sold', label: 'Sold' },
    { value: 'paid_out', label: 'Paid Out' },
    { value: 'returned', label: 'Returned' },
  ];

  return (
    <PageLayout
      title="Consignments"
      subtitle={`${activeCount} active \u00b7 ${fmt(totalAgreed)} BHD total agreed value`}
      showSearch onSearch={setSearch} searchPlaceholder="Search by number, consignor, product..."
      actions={
        <div className="flex items-center gap-3">
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {statusFilters.map(sf => (
              <button key={sf.value} onClick={() => setStatusFilter(sf.value)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${statusFilter === sf.value ? '#0F0F10' : 'transparent'}`,
                  color: statusFilter === sf.value ? '#0F0F10' : '#6B7280',
                  background: statusFilter === sf.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}>{sf.label}</button>
            ))}
          </div>
          <Button variant="primary" onClick={openNew}>New Consignment</Button>
        </div>
      }
    >
      {outstandingCount > 0 && (
        <div style={{
          marginBottom: 20, padding: '14px 18px', borderRadius: 10,
          border: '1px solid rgba(170,110,110,0.25)', background: 'rgba(170,110,110,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
              Outstanding Consignor Payouts
            </div>
            <div style={{ fontSize: 18, fontWeight: 400, color: '#AA6E6E' }}>
              {fmt(outstandingPayouts)} BHD <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 400 }}>· {outstandingCount} consignment{outstandingCount > 1 ? 's' : ''} sold, not yet paid out</span>
            </div>
          </div>
          <button onClick={() => setStatusFilter('sold')} className="cursor-pointer"
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid #AA6E6E', background: 'transparent', color: '#AA6E6E' }}>
            View sold
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <FileText size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {search || statusFilter ? 'No consignments match your filters.' : 'No consignments yet.'}
          </p>
        </div>
      ) : (
        <Card noPadding>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E1D6' }}>
                {['Number', 'Consignor', 'Product', 'Agreed Price', 'Commission', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '14px 18px', textAlign: 'left', fontSize: 11,
                    fontWeight: 500, letterSpacing: '0.06em', color: '#6B7280',
                    textTransform: 'uppercase',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(con => {
                const cust = getCustomer(con.consignorId);
                const prod = getProduct(con.productId);
                const custName = cust ? `${cust.firstName} ${cust.lastName}` : '\u2014';
                const prodLabel = prod ? `${prod.brand} ${prod.name}` : '\u2014';

                return (
                  <tr key={con.id}
                    className="cursor-pointer transition-colors duration-200"
                    style={{ borderBottom: '1px solid #E5E1D6' }}
                    onClick={() => navigate(`/consignments/${con.id}`)}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.015)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '14px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{con.consignmentNumber}</span>
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <span style={{ fontSize: 13, color: '#0F0F10' }}>{custName}</span>
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <div>
                        <span style={{ fontSize: 13, color: '#0F0F10' }}>{prodLabel}</span>
                        {prod?.sku && (
                          <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>{prod.sku}</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(con.agreedPrice)}</span>
                      <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>BHD</span>
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmtPct(con.commissionRate)}%</span>
                      {con.commissionAmount !== undefined && (
                        <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>
                          {fmt(con.commissionAmount)} BHD
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <StatusDot status={con.status} />
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <div className="flex gap-1">
                        {con.status === 'active' && (
                          <>
                            <button
                              onClick={() => { setSoldModal(con.id); setSoldPrice(String(con.agreedPrice)); }}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 6,
                                border: '1px solid #D5D1C4', color: '#7EAA6E',
                                background: 'transparent',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(126,170,110,0.08)'; e.currentTarget.style.borderColor = '#7EAA6E'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D1C4'; }}
                            >Sold</button>
                            <button
                              onClick={() => markReturned(con.id)}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 6,
                                border: '1px solid #D5D1C4', color: '#6B7280',
                                background: 'transparent',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = '#6B7280'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D1C4'; }}
                            >Return</button>
                          </>
                        )}
                        {con.status === 'sold' && (
                          <button
                            onClick={() => setPaidModal(con.id)}
                            className="cursor-pointer transition-all duration-200"
                            style={{
                              padding: '4px 10px', fontSize: 11, borderRadius: 6,
                              border: '1px solid #D5D1C4', color: '#0F0F10',
                              background: 'transparent',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(15,15,16,0.08)'; e.currentTarget.style.borderColor = '#0F0F10'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D1C4'; }}
                          >Pay Out</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── New Consignment Modal ── */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Consignment" width={660}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>

          {/* Consignor Selection */}
          <div>
            <SearchSelect
              label="CONSIGNOR"
              placeholder="Search clients..."
              options={customers.map(c => ({ id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone }))}
              value={form.consignorId}
              onChange={id => setForm({ ...form, consignorId: id })}
            />
            <button onClick={() => setShowQuickCustomer(true)}
              className="cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, marginTop: 6, padding: 0 }}
            >+ New Client</button>
          </div>

          {/* Product Selection */}
          <SearchSelect
            label="PRODUCT"
            placeholder="Search products..."
            options={products.filter(p => p.stockStatus === 'in_stock').map(p => ({
              id: p.id, label: `${p.brand} ${p.name}`, subtitle: `${fmt(p.purchasePrice)} BHD`, meta: p.sku,
            }))}
            value={form.productId}
            onChange={id => setForm({ ...form, productId: id })}
          />

          {/* Pricing */}
          <div style={{ borderTop: '1px solid #E5E1D6', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 12 }}>PRICING</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
              <Input label="AGREED PRICE (BHD)" type="number" placeholder="Optional \u2014 set at sale"
                value={form.agreedPrice}
                onChange={e => setForm({ ...form, agreedPrice: e.target.value })} />
              <Input label="MINIMUM PRICE (BHD)" type="number" placeholder="Optional"
                value={form.minimumPrice}
                onChange={e => setForm({ ...form, minimumPrice: e.target.value })} />
            </div>
            <div style={{ marginTop: 16 }}>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>PAYOUT MODEL</span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {(['percent', 'fixed', 'consignor_fixed'] as const).map(t => (
                  <button key={t} onClick={() => setCommissionType(t)}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '7px 12px', fontSize: 12,
                      border: `1px solid ${commissionType === t ? '#0F0F10' : '#D5D1C4'}`,
                      color: commissionType === t ? '#0F0F10' : '#6B7280',
                      background: commissionType === t ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>
                    {t === 'percent' ? 'Commission % to us'
                      : t === 'fixed' ? 'Commission fixed to us'
                      : 'Fixed payout to consignor'}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                {commissionType === 'consignor_fixed'
                  ? 'Consignor gets a fixed BHD amount when sold — our margin is whatever is above it.'
                  : commissionType === 'fixed'
                  ? 'We keep a fixed BHD amount as commission — consignor gets the rest.'
                  : 'We keep a percentage of the sale price — consignor gets the rest.'}
              </p>
            </div>
            <div style={{ marginTop: 16 }}>
              <Input
                label={
                  commissionType === 'percent' ? 'COMMISSION RATE (%)'
                  : commissionType === 'fixed' ? 'COMMISSION AMOUNT (BHD)'
                  : 'PAYOUT TO CONSIGNOR (BHD)'
                }
                type="number"
                placeholder={commissionType === 'percent' ? '15' : '0'}
                value={form.commissionRate}
                onChange={e => setForm({ ...form, commissionRate: e.target.value })} />
            </div>

            {/* Live Calculation */}
            {agreedNum > 0 && rateNum > 0 && (
              <div className="rounded font-mono" style={{
                marginTop: 16, padding: 16, background: '#EFECE2',
                border: '1px solid #E5E1D6', fontSize: 13,
              }}>
                <div style={{ marginBottom: 4, color: '#6B7280', fontSize: 11, letterSpacing: '0.04em' }}>
                  IF SOLD AT AGREED PRICE
                </div>
                <div className="flex justify-between" style={{ marginTop: 10 }}>
                  <span style={{ color: '#6B7280' }}>Commission {commissionType === 'percent' ? `(${fmtPct(rateNum)}%)` : '(fixed)'}</span>
                  <span style={{ color: '#0F0F10' }}>{fmt(commission)} BHD</span>
                </div>
                <div className="flex justify-between" style={{ marginTop: 8 }}>
                  <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                  <span style={{ color: '#7EAA6E' }}>{fmt(payout)} BHD</span>
                </div>
              </div>
            )}
          </div>

          {/* Expiry & Notes */}
          <div style={{ borderTop: '1px solid #E5E1D6', paddingTop: 20 }}>
            <Input label="EXPIRY DATE" type="date"
              value={form.expiryDate}
              onChange={e => setForm({ ...form, expiryDate: e.target.value })} />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
            <textarea
              placeholder="Any special terms or notes..."
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              className="w-full outline-none transition-colors duration-300"
              style={{
                marginTop: 6, background: 'transparent',
                borderBottom: '1px solid #D5D1C4', border: 'none',
                borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: '#D5D1C4',
                padding: '10px 0', fontSize: 14, color: '#0F0F10',
                resize: 'vertical', minHeight: 60,
              }}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => (e.currentTarget.style.borderBottomColor = '#D5D1C4')}
            />
          </div>

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}
              disabled={!form.consignorId || !form.productId}
            >Create Consignment</Button>
          </div>
        </div>
      </Modal>

      <QuickCustomerModal
        open={showQuickCustomer}
        onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => { loadCustomers(); setForm(f => ({ ...f, consignorId: id })); }}
      />

      {/* ── Mark Sold Modal ── */}
      <Modal open={!!soldModal} onClose={() => setSoldModal(null)} title="Mark as Sold" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Input label="SALE PRICE (BHD)" type="number" placeholder="0"
            value={soldPrice}
            onChange={e => setSoldPrice(e.target.value)} />
          {Number(soldPrice) > 0 && soldModal && (() => {
            const con = consignments.find(c => c.id === soldModal);
            if (!con) return null;
            const sp = Number(soldPrice);
            let comm: number; let po: number;
            if (con.commissionType === 'consignor_fixed') {
              po = con.commissionValue || 0;
              comm = Math.max(0, sp - po);
            } else if (con.commissionType === 'fixed') {
              comm = con.commissionValue || 0;
              po = sp - comm;
            } else {
              comm = sp * (con.commissionRate / 100);
              po = sp - comm;
            }
            const modelLabel = con.commissionType === 'consignor_fixed' ? 'Our margin'
              : con.commissionType === 'fixed' ? 'Commission (fixed)'
              : `Commission (${fmtPct(con.commissionRate)}%)`;
            return (
              <div className="rounded font-mono" style={{
                padding: 14, background: '#EFECE2', border: '1px solid #E5E1D6', fontSize: 13,
              }}>
                <div className="flex justify-between" style={{ marginBottom: 8 }}>
                  <span style={{ color: '#6B7280' }}>{modelLabel}</span>
                  <span style={{ color: '#0F0F10' }}>{fmt(comm)} BHD</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6B7280' }}>Payout to consignor</span>
                  <span style={{ color: '#7EAA6E' }}>{fmt(po)} BHD</span>
                </div>
              </div>
            );
          })()}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>SALE RECEIVED IN</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['cash', 'bank'] as const).map(m => (
                <button key={m} onClick={() => setSoldSaleMethod(m)}
                  className="cursor-pointer rounded transition-all"
                  style={{ padding: '8px 16px', fontSize: 13,
                    border: `1px solid ${soldSaleMethod === m ? '#0F0F10' : '#D5D1C4'}`,
                    color: soldSaleMethod === m ? '#0F0F10' : '#6B7280',
                    background: soldSaleMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 16, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setSoldModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleMarkSold} disabled={!soldPrice}>Confirm Sale</Button>
          </div>
        </div>
      </Modal>

      {/* ── Mark Paid Out Modal ── */}
      <Modal open={!!paidModal} onClose={() => setPaidModal(null)} title="Pay Out Consignor" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {paidModal && (() => {
            const con = consignments.find(c => c.id === paidModal);
            if (!con) return null;
            const cust = getCustomer(con.consignorId);
            return (
              <div className="rounded font-mono" style={{
                padding: 14, background: '#EFECE2', border: '1px solid #E5E1D6', fontSize: 13,
              }}>
                <div className="flex justify-between" style={{ marginBottom: 8 }}>
                  <span style={{ color: '#6B7280' }}>Consignor</span>
                  <span style={{ color: '#0F0F10' }}>{cust ? `${cust.firstName} ${cust.lastName}` : '\u2014'}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6B7280' }}>Payout Amount</span>
                  <span style={{ color: '#7EAA6E' }}>{fmt(con.payoutAmount || 0)} BHD</span>
                </div>
              </div>
            );
          })()}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>PAYMENT METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {['bank_transfer', 'cash', 'card'].map(m => (
                <button key={m} onClick={() => setPaidMethod(m)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${paidMethod === m ? '#0F0F10' : '#D5D1C4'}`,
                    color: paidMethod === m ? '#0F0F10' : '#6B7280',
                    background: paidMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'bank_transfer' ? 'Bank Transfer' : m === 'cash' ? 'Cash' : 'Card'}</button>
              ))}
            </div>
          </div>
          <Input label="REFERENCE" placeholder="Optional reference..."
            value={paidRef}
            onChange={e => setPaidRef(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 16, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setPaidModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleMarkPaid}>Confirm Payout</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
