import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Receipt, Download, Table } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useOfferStore } from '@/stores/offerStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { exportCsv } from '@/core/utils/export-file';
import { exportNbrVatReport } from '@/core/tax/nbr-export';
import { matchesDeep } from '@/core/utils/deep-search';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtDate(iso?: string): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// Display-Status: leitet aus invoice.status + paid + returnState einen User-friendly Label ab.
// Reihenfolge: CANCELLED > Returned > Partially Returned > Draft > Paid > Partially Paid > Unpaid.
type DisplayStatus = 'Cancelled' | 'Returned' | 'Partially Returned' | 'Draft' | 'Paid' | 'Partially Paid' | 'Unpaid';

function deriveDisplayStatus(
  inv: { status: string; grossAmount: number; paidAmount: number },
  returnState: 'NONE' | 'PARTIAL_RETURN' | 'RETURNED'
): DisplayStatus {
  if (inv.status === 'CANCELLED') return 'Cancelled';
  if (returnState === 'RETURNED') return 'Returned';
  if (returnState === 'PARTIAL_RETURN') return 'Partially Returned';
  if (inv.status === 'DRAFT') return 'Draft';
  if (inv.paidAmount >= inv.grossAmount - 0.005) return 'Paid';
  if (inv.paidAmount > 0.005) return 'Partially Paid';
  return 'Unpaid';
}

const STATUS_STYLE: Record<DisplayStatus, { fg: string; bg: string }> = {
  'Paid':                { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
  'Partially Paid':      { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)' },
  'Unpaid':              { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  'Returned':            { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  'Partially Returned':  { fg: '#D97706', bg: 'rgba(217,119,6,0.10)' },
  'Cancelled':           { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)' },
  'Draft':               { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)' },
};

export function InvoiceList() {
  const navigate = useNavigate();
  const { invoices, loadInvoices, recordPayment } = useInvoiceStore();
  const { loadReturns: loadSalesReturns, getInvoiceReturnSummary } = useSalesReturnStore();
  const { offers, loadOffers } = useOfferStore();
  const { customers, loadCustomers } = useCustomerStore();
  const [searchParams, setSearchParams] = useSearchParams();
  // Plan §Filter — Dashboard-Klick → ?filter=PARTIAL etc. übernimmt initialen Filter.
  const [filterStatus, setFilterStatus] = useState(searchParams.get('filter') || '');
  const [searchQuery, setSearchQuery] = useState('');

  // Bei Filter-Änderung URL syncen (für Browser-Back/Forward + bookmarkable)
  useEffect(() => {
    const current = searchParams.get('filter') || '';
    if (current !== filterStatus) {
      const next = new URLSearchParams(searchParams);
      if (filterStatus) next.set('filter', filterStatus); else next.delete('filter');
      setSearchParams(next, { replace: true });
    }
  }, [filterStatus, searchParams, setSearchParams]);
  const [showFromOffer, setShowFromOffer] = useState(false);
  const { products, loadProducts } = useProductStore();
  const [showPayment, setShowPayment] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState('bank_transfer');
  const [showNbrExport, setShowNbrExport] = useState(false);
  const [nbrYear, setNbrYear] = useState(new Date().getFullYear());
  const [nbrSelected, setNbrSelected] = useState<Set<string>>(new Set());
  const [nbrResult, setNbrResult] = useState<{ filename: string; invoiceCount: number; totals: { standardNet: number; standardVat: number; marginProfit: number; zeroRated: number } } | null>(null);

  // Invoices in scope for the selected year (excluding draft/cancelled)
  const nbrCandidates = useMemo(() => {
    return invoices.filter(inv => {
      const iso = inv.issuedAt || inv.createdAt;
      if (!iso) return false;
      if (new Date(iso).getFullYear() !== nbrYear) return false;
      if (inv.status === 'CANCELLED' || inv.status === 'DRAFT') return false;
      return true;
    }).sort((a, b) => (a.issuedAt || a.createdAt).localeCompare(b.issuedAt || b.createdAt));
  }, [invoices, nbrYear]);

  // When modal opens or year/candidates change, default select all non-butterfly invoices
  useEffect(() => {
    if (!showNbrExport) return;
    setNbrSelected(new Set(nbrCandidates.filter(i => !i.butterfly).map(i => i.id)));
    setNbrResult(null);
  }, [showNbrExport, nbrCandidates]);

  useEffect(() => { loadInvoices(); loadOffers(); loadCustomers(); loadProducts(); loadSalesReturns(); }, [loadInvoices, loadOffers, loadCustomers, loadProducts, loadSalesReturns]);

  // URL-Param: /invoices?customer=:id → nur Invoices dieses Kunden anzeigen.
  const customerFilter = searchParams.get('customer') || '';
  const customerFilterName = useMemo(() => {
    if (!customerFilter) return '';
    const c = customers.find(cc => cc.id === customerFilter);
    return c ? `${c.firstName} ${c.lastName}`.trim() || c.company || '' : '';
  }, [customerFilter, customers]);

  const filtered = useMemo(() => {
    let r = invoices;
    if (customerFilter) r = r.filter(i => i.customerId === customerFilter);
    // Special filter "returns": Invoices mit offenem Refund-Payable
    if (filterStatus === 'returns') {
      r = r.filter(inv => {
        const sum = getInvoiceReturnSummary(inv.id, inv.grossAmount, inv.paidAmount);
        return sum.outstandingRefund > 0.001;
      });
    } else if (filterStatus) {
      r = r.filter(i => i.status === filterStatus);
    }
    if (searchQuery) {
      r = r.filter(inv => {
        const customer = customers.find(c => c.id === inv.customerId);
        const lineProducts = (inv.lines || []).map(l => products.find(p => p.id === l.productId)).filter(Boolean);
        return matchesDeep(inv, searchQuery, [customer, ...lineProducts]);
      });
    }
    return r;
  }, [invoices, filterStatus, searchQuery, customers, products, customerFilter]);

  const acceptedOffers = useMemo(() => offers.filter(o => o.status === 'accepted'), [offers]);

  function handleExportCsv() {
    const rows = invoices.map(inv => {
      const c = customers.find(x => x.id === inv.customerId);
      const customerName = c ? `${c.firstName} ${c.lastName}${c.company ? ' (' + c.company + ')' : ''}` : '';
      return {
        invoice_number: inv.invoiceNumber,
        date: (inv.issuedAt || inv.createdAt || '').split('T')[0],
        status: inv.status,
        customer: customerName,
        tax_scheme: inv.taxSchemeSnapshot,
        net: inv.netAmount.toFixed(3),
        vat_rate: inv.vatRateSnapshot ?? '',
        vat: inv.vatAmount.toFixed(3),
        gross: inv.grossAmount.toFixed(3),
        paid: inv.paidAmount.toFixed(3),
        currency: inv.currency,
      };
    });
    const headers = Object.keys(rows[0] || { invoice_number: '', date: '', status: '', customer: '', tax_scheme: '', net: '', vat_rate: '', vat: '', gross: '', paid: '', currency: '' });
    const escape = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => escape((r as Record<string, unknown>)[h])).join(','))].join('\n');
    exportCsv(`invoices-${new Date().toISOString().split('T')[0]}.csv`, csv);
  }

  function handleNbrExport() {
    const result = exportNbrVatReport(nbrYear, invoices, customers, products, Array.from(nbrSelected));
    setNbrResult(result);
  }

  function toggleNbrInvoice(id: string) {
    setNbrSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleCreateFromOffer(offerId: string) {
    // Plan §Sales §5: VAT-Scheme pro Zeile muss VOR der Rechnungserstellung wählbar sein.
    // Picker sitzt in OfferDetail — dorthin navigieren statt direkt Rechnung anzulegen.
    setShowFromOffer(false);
    navigate(`/offers/${offerId}`);
  }

  function handlePayment() {
    if (!showPayment || payAmount <= 0) return;
    recordPayment(showPayment, payAmount, payMethod);
    setShowPayment(null);
    setPayAmount(0);
  }

  return (
    <PageLayout
      title="Invoices"
      subtitle={customerFilter
        ? `Filtered by client: ${customerFilterName || customerFilter} \u00b7 ${filtered.length} invoice${filtered.length === 1 ? '' : 's'}`
        : `${invoices.length} invoices \u00b7 ${invoices.filter(i => i.status !== 'CANCELLED' && i.paidAmount < i.grossAmount - 0.005).length} open`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search by invoice #, client, product..."
      actions={
        <div className="flex gap-2">
          {customerFilter && (
            <button onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('customer');
              setSearchParams(next, { replace: true });
            }} className="cursor-pointer transition-colors flex items-center gap-1"
              style={{ padding: '6px 12px', fontSize: 12, borderRadius: 999, border: '1px solid #DC2626', background: 'rgba(220,38,38,0.06)', color: '#DC2626' }}>
              \u2715 Clear client filter
            </button>
          )}
          <div className="flex gap-1" style={{ marginRight: 8 }}>
            {['', 'DRAFT', 'PARTIAL', 'FINAL', 'CANCELLED'].map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className="cursor-pointer" style={{
                  padding: '5px 10px', fontSize: 11, borderRadius: 999, border: 'none',
                  background: filterStatus === s ? 'rgba(15,15,16,0.08)' : 'transparent',
                  color: filterStatus === s ? '#0F0F10' : '#6B7280',
                }}>{s || 'All'}</button>
            ))}
          </div>
          <Button variant="ghost" onClick={handleExportCsv} disabled={invoices.length === 0}><Download size={14} /> CSV</Button>
          <Button variant="secondary" onClick={() => { setNbrResult(null); setShowNbrExport(true); }} disabled={invoices.length === 0}><Table size={14} /> NBR VAT</Button>
          <Button variant="secondary" onClick={() => navigate('/invoices/new')}>Direct Sale</Button>
          <Button variant="primary" onClick={() => setShowFromOffer(true)}>From Offer</Button>
        </div>
      }
    >
      {/* Table — Plan §Sales Übersicht: Net/VAT entfernt, Remaining + granulare Status. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,1.1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr)', gap: 12, padding: '0 12px 10px' }}>
        {['DATE', 'INVOICE #', 'CLIENT', 'PHONE', 'TOTAL', 'PAID', 'REMAINING', 'STATUS'].map(h => (
          <span key={h} className="text-overline">{h}</span>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <Receipt size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>No invoices yet.</p>
        </div>
      )}

      {filtered.map(inv => {
        const customer = customers.find(c => c.id === inv.customerId);
        const remaining = Math.max(0, inv.grossAmount - inv.paidAmount);
        const sum = getInvoiceReturnSummary(inv.id, inv.grossAmount, inv.paidAmount);
        const displayStatus = deriveDisplayStatus(inv, sum.returnState);
        const statusStyle = STATUS_STYLE[displayStatus];
        const isOpenPayment = displayStatus === 'Partially Paid' || displayStatus === 'Unpaid';
        return (
          <div key={inv.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid', gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,1.1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr)',
              gap: 12, padding: '14px 12px', alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => navigate(`/invoices/${inv.id}`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtDate(inv.issuedAt || inv.createdAt)}
            </span>
            <span className="font-mono flex items-center gap-1" style={{ fontSize: 12, color: '#0F0F10', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {inv.invoiceNumber}
              {inv.butterfly && <span title="Butterfly (excluded from NBR export)" style={{ fontSize: 12 }}>&#x1F98B;</span>}
            </span>
            <span style={{ fontSize: 13, color: '#0F0F10', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {customer ? `${customer.firstName} ${customer.lastName}`.trim() || customer.company || '—' : '—'}
            </span>
            <span className="font-mono" style={{ fontSize: 12, color: '#4B5563', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {customer?.phone || customer?.whatsapp || '\u2014'}
            </span>
            <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(inv.grossAmount)}</span>
            <span className="font-mono" style={{ fontSize: 13, color: inv.paidAmount >= inv.grossAmount - 0.005 ? '#16A34A' : '#4B5563' }}>
              {fmt(inv.paidAmount)}
            </span>
            <span className="font-mono" style={{ fontSize: 13, color: remaining > 0.005 ? '#DC2626' : '#9CA3AF' }}>
              {remaining > 0.005 ? fmt(remaining) : '—'}
            </span>
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span
                title={displayStatus === 'Partially Returned'
                  ? `Returned ${sum.totalReturned.toFixed(2)} of ${inv.grossAmount.toFixed(2)} BHD`
                  : displayStatus}
                style={{
                  padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                  color: statusStyle.fg, background: statusStyle.bg,
                  border: `1px solid ${statusStyle.fg}33`, whiteSpace: 'nowrap',
                }}>
                {displayStatus}
              </span>
              {isOpenPayment && (
                <button onClick={(e) => { e.stopPropagation(); setShowPayment(inv.id); setPayAmount(remaining); }}
                  className="cursor-pointer" style={{
                    padding: '3px 8px', fontSize: 10, border: '1px solid #16A34A',
                    color: '#16A34A', borderRadius: 4, background: 'none',
                  }}>Pay</button>
              )}
            </div>
          </div>
        );
      })}

      {/* Create from Offer */}
      <Modal open={showFromOffer} onClose={() => setShowFromOffer(false)} title="Create Invoice from Offer" width={500}>
        <div>
          {acceptedOffers.length === 0 ? (
            <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No offers available. Create an offer first.</p>
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {acceptedOffers.map(offer => {
                const customer = customers.find(c => c.id === offer.customerId);
                return (
                  <div key={offer.id}
                    className="cursor-pointer rounded transition-colors"
                    style={{ padding: '12px', marginBottom: 4, border: '1px solid #E5E9EE' }}
                    onClick={() => handleCreateFromOffer(offer.id)}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E9EE')}
                  >
                    <div className="flex justify-between" style={{ marginBottom: 4 }}>
                      <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{offer.offerNumber}</span>
                      <StatusDot status={offer.status} />
                    </div>
                    <div className="flex justify-between">
                      <span style={{ fontSize: 13, color: '#0F0F10' }}>
                        {customer ? `${customer.firstName} ${customer.lastName}` : '—'}
                      </span>
                      <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(offer.total)} BHD</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      {/* Record Payment */}
      <Modal open={!!showPayment} onClose={() => setShowPayment(null)} title="Record Payment" width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="AMOUNT (BHD)" type="number" value={payAmount || ''} onChange={e => setPayAmount(Number(e.target.value))} />
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>METHOD</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {['bank_transfer', 'cash', 'card', 'crypto'].map(m => (
                <button key={m} onClick={() => setPayMethod(m)}
                  className="cursor-pointer rounded" style={{
                    padding: '6px 14px', fontSize: 12,
                    border: `1px solid ${payMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: payMethod === m ? '#0F0F10' : '#6B7280',
                    background: payMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m.replace('_', ' ')}</button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowPayment(null)}>Cancel</Button>
            <Button variant="primary" onClick={handlePayment}>Record Payment</Button>
          </div>
        </div>
      </Modal>

      <Modal open={showNbrExport} onClose={() => setShowNbrExport(false)} title="NBR VAT Export" width={720}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '72vh' }}>
          <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>
            Generates an Excel file with one sheet per month. Butterfly-flagged invoices are excluded by default — toggle them on if they should be reported.
          </p>

          <Input
            label="YEAR"
            type="number"
            value={nbrYear}
            onChange={e => setNbrYear(parseInt(e.target.value) || new Date().getFullYear())}
            step="1"
            min="2020"
            max="2100"
          />

          {/* Invoice Selection */}
          <div>
            <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
              <span className="text-overline">INVOICES IN {nbrYear} · {nbrSelected.size}/{nbrCandidates.length} selected</span>
              <div className="flex gap-2">
                <button onClick={() => setNbrSelected(new Set(nbrCandidates.map(i => i.id)))}
                  className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11 }}>Select all</button>
                <span style={{ color: '#9CA3AF', fontSize: 11 }}>·</span>
                <button onClick={() => setNbrSelected(new Set(nbrCandidates.filter(i => !i.butterfly).map(i => i.id)))}
                  className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11 }}>Without butterfly</button>
                <span style={{ color: '#9CA3AF', fontSize: 11 }}>·</span>
                <button onClick={() => setNbrSelected(new Set())}
                  className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 11 }}>Clear</button>
              </div>
            </div>
            <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid #E5E9EE', borderRadius: 8 }}>
              {nbrCandidates.length === 0 && (
                <p style={{ padding: 16, fontSize: 12, color: '#6B7280', textAlign: 'center' }}>No issued invoices for {nbrYear}.</p>
              )}
              {nbrCandidates.map(inv => {
                const cust = customers.find(c => c.id === inv.customerId);
                const checked = nbrSelected.has(inv.id);
                return (
                  <label key={inv.id} className="flex items-center gap-3 cursor-pointer"
                    style={{ padding: '8px 12px', borderBottom: '1px solid #E5E9EE', fontSize: 12 }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleNbrInvoice(inv.id)} style={{ accentColor: '#0F0F10' }} />
                    <span className="font-mono" style={{ color: '#0F0F10', minWidth: 110 }}>{inv.invoiceNumber}</span>
                    <span style={{ color: '#6B7280', minWidth: 72 }}>{(inv.issuedAt || inv.createdAt).split('T')[0]}</span>
                    <span style={{ color: '#0F0F10', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cust ? `${cust.firstName} ${cust.lastName}` : '—'}
                      {cust?.personalId && <span style={{ color: '#6B7280', marginLeft: 6 }}>({cust.personalId})</span>}
                    </span>
                    <span className="font-mono" style={{ color: '#4B5563', minWidth: 90, textAlign: 'right' }}>{inv.grossAmount.toFixed(2)}</span>
                    {inv.butterfly && <span title="Butterfly" style={{ fontSize: 12 }}>&#x1F98B;</span>}
                  </label>
                );
              })}
            </div>
          </div>

          {nbrResult && (
            <div style={{ padding: 14, background: 'rgba(126,170,110,0.06)', border: '1px solid rgba(126,170,110,0.2)', borderRadius: 8 }}>
              <p style={{ fontSize: 13, color: '#7EAA6E', marginBottom: 10 }}>Downloaded: {nbrResult.filename}</p>
              <div style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.9 }}>
                <div className="flex justify-between"><span>Invoices included:</span><span className="font-mono">{nbrResult.invoiceCount}</span></div>
                <div className="flex justify-between"><span>Standard (net):</span><span className="font-mono">{nbrResult.totals.standardNet.toFixed(2)} BHD</span></div>
                <div className="flex justify-between"><span>Standard (VAT):</span><span className="font-mono">{nbrResult.totals.standardVat.toFixed(2)} BHD</span></div>
                <div className="flex justify-between"><span>Margin (profit):</span><span className="font-mono">{nbrResult.totals.marginProfit.toFixed(2)} BHD</span></div>
                <div className="flex justify-between"><span>Zero-rated:</span><span className="font-mono">{nbrResult.totals.zeroRated.toFixed(2)} BHD</span></div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNbrExport(false)}>Close</Button>
            <Button variant="primary" onClick={handleNbrExport} disabled={nbrSelected.size === 0}>Generate Excel ({nbrSelected.size})</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
