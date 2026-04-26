import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect, SearchMultiSelect } from '@/components/ui/SearchSelect';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { useOfferStore } from '@/stores/offerStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { vatEngine } from '@/core/tax/vat-engine';
import { matchesDeep } from '@/core/utils/deep-search';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function OfferList() {
  const navigate = useNavigate();
  const { offers, loadOffers, createOffer, updateOffer, deleteOffer } = useOfferStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts } = useProductStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showNew, setShowNew] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [linePrices, setLinePrices] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);

  useEffect(() => { loadOffers(); loadCustomers(); loadProducts(); }, [loadOffers, loadCustomers, loadProducts]);

  // Pre-fill from URL params (e.g. /offers?product=p-1&customer=c-1)
  useEffect(() => {
    const productParam = searchParams.get('product');
    const customerParam = searchParams.get('customer');
    if (productParam || customerParam) {
      if (customerParam) setSelectedCustomerId(customerParam);
      if (productParam) setSelectedProductIds([productParam]);
      setShowNew(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const filtered = useMemo(() => {
    let r = offers;
    if (filterStatus) r = r.filter(o => o.status === filterStatus);
    if (searchQuery) {
      r = r.filter(o => {
        const customer = customers.find(c => c.id === o.customerId);
        const lineProducts = (o.lines || []).map(l => products.find(p => p.id === l.productId)).filter(Boolean);
        return matchesDeep(o, searchQuery, [customer, ...lineProducts]);
      });
    }
    return r;
  }, [offers, filterStatus, searchQuery, customers, products]);

  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone,
  })), [customers]);

  const productOptions = useMemo(() => products.filter(p => p.stockStatus === 'in_stock').map(p => ({
    id: p.id, label: `${p.brand} ${p.name}`, subtitle: `${fmt(p.plannedSalePrice || p.purchasePrice)} BHD`, meta: p.sku,
  })), [products]);

  // When products are selected, init their prices from plannedSalePrice
  useEffect(() => {
    const newPrices = { ...linePrices };
    for (const id of selectedProductIds) {
      if (!(id in newPrices)) {
        const p = products.find(pr => pr.id === id);
        if (p) newPrices[id] = p.plannedSalePrice || p.purchasePrice;
      }
    }
    setLinePrices(newPrices);
  }, [selectedProductIds, products]);

  const selectedProducts = useMemo(() => {
    return selectedProductIds.map(id => {
      const p = products.find(pr => pr.id === id);
      if (!p) return null;
      return { productId: p.id, unitPrice: linePrices[id] ?? p.plannedSalePrice ?? p.purchasePrice, purchasePrice: p.purchasePrice, taxScheme: p.taxScheme };
    }).filter(Boolean) as { productId: string; unitPrice: number; purchasePrice: number; taxScheme: string }[];
  }, [selectedProductIds, products, linePrices]);

  const total = useMemo(() => {
    // Plan §Tax §7: Netto-Eingabe. Total = Summe aus Brutto (Kundenpreis).
    let gross = 0, vat = 0;
    for (const line of selectedProducts) {
      const calc = vatEngine.calculateNet(line.unitPrice, line.purchasePrice, line.taxScheme as any, 10);
      gross += calc.grossAmount;
      vat += calc.vatAmount;
    }
    return { subtotal: gross - vat, vatAmount: vat, total: gross };
  }, [selectedProducts]);

  function handleCreate() {
    if (!selectedCustomerId || selectedProducts.length === 0) return;
    try {
      createOffer(selectedCustomerId, selectedProducts, notes, validUntil);
      setShowNew(false);
      setSelectedCustomerId('');
      setSelectedProductIds([]);
      setLinePrices({});
      setNotes('');
      setValidUntil('');
    } catch (e) {
      alert(`Could not create offer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <PageLayout
      title="Offers"
      subtitle={`${offers.length} offers`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search by offer #, client, product..."
      actions={
        <div className="flex gap-2">
          <div className="flex gap-1" style={{ marginRight: 8 }}>
            {['', 'draft', 'sent', 'accepted', 'rejected', 'expired'].map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className="cursor-pointer" style={{
                  padding: '5px 10px', fontSize: 11, borderRadius: 999, border: 'none',
                  background: filterStatus === s ? 'rgba(15,15,16,0.08)' : 'transparent',
                  color: filterStatus === s ? '#0F0F10' : '#6B7280',
                }}>{s || 'All'}</button>
            ))}
          </div>
          <Button variant="primary" onClick={() => setShowNew(true)}>New Offer</Button>
        </div>
      }
    >
      {/* Table */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr 1fr', gap: 12, padding: '0 12px 10px' }}>
        {['OFFER #', 'CLIENT', 'ITEMS', 'TOTAL', 'STATUS', 'DATE'].map(h => (
          <span key={h} className="text-overline">{h}</span>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <FileText size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>No offers yet.</p>
        </div>
      )}

      {filtered.map(offer => {
        const customer = customers.find(c => c.id === offer.customerId);
        return (
          <div key={offer.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr 1fr',
              gap: 12, padding: '14px 12px', alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => navigate(`/offers/${offer.id}`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{offer.offerNumber}</span>
            <span style={{ fontSize: 13, color: '#0F0F10' }}>
              {customer ? `${customer.firstName} ${customer.lastName}` : '—'}
            </span>
            <span style={{ fontSize: 13, color: '#4B5563' }}>{offer.lines.length} items</span>
            <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(offer.total)} BHD</span>
            <div className="flex items-center gap-2">
              <StatusDot status={offer.status} />
              {offer.status === 'draft' && (
                <button onClick={(e) => { e.stopPropagation(); updateOffer(offer.id, { status: 'sent', sentAt: new Date().toISOString() }); }}
                  className="cursor-pointer" style={{ padding: '2px 8px', fontSize: 10, border: '1px solid #6E8AAA', color: '#6E8AAA', borderRadius: 4, background: 'none' }}>Send</button>
              )}
              {offer.status === 'sent' && (
                <>
                  <button onClick={(e) => { e.stopPropagation(); updateOffer(offer.id, { status: 'accepted' }); }}
                    className="cursor-pointer" style={{ padding: '2px 8px', fontSize: 10, border: '1px solid #7EAA6E', color: '#7EAA6E', borderRadius: 4, background: 'none' }}>Accept</button>
                  <button onClick={(e) => { e.stopPropagation(); updateOffer(offer.id, { status: 'rejected' }); }}
                    className="cursor-pointer" style={{ padding: '2px 8px', fontSize: 10, border: '1px solid #AA6E6E', color: '#AA6E6E', borderRadius: 4, background: 'none' }}>Reject</button>
                </>
              )}
              {(offer.status === 'draft' || offer.status === 'rejected' || offer.status === 'expired') && (
                <button onClick={(e) => { e.stopPropagation(); deleteOffer(offer.id); }}
                  className="cursor-pointer" style={{ padding: '2px 8px', fontSize: 10, border: '1px solid #6B7280', color: '#6B7280', borderRadius: 4, background: 'none' }}>Delete</button>
              )}
            </div>
            <span style={{ fontSize: 12, color: '#6B7280' }}>{offer.createdAt?.split('T')[0]}</span>
          </div>
        );
      })}

      <QuickCustomerModal
        open={showQuickCustomer}
        onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => { loadCustomers(); setSelectedCustomerId(id); }}
      />

      {/* New Offer Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Offer" width={640}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
          {/* Customer */}
          <div>
            <SearchSelect
              label="CLIENT"
              placeholder="Search clients by name, company, phone..."
              options={customerOptions}
              value={selectedCustomerId}
              onChange={setSelectedCustomerId}
            />
            <button onClick={() => setShowQuickCustomer(true)}
              className="cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, marginTop: 6, padding: 0 }}
            >+ New Client</button>
          </div>

          {/* Products */}
          <SearchMultiSelect
            label="ITEMS"
            placeholder="Search products by brand, name, SKU..."
            options={productOptions}
            value={selectedProductIds}
            onChange={setSelectedProductIds}
          />

          {/* Line Prices (editable) */}
          {selectedProductIds.length > 0 && (
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>PRICING</span>
              <div style={{ marginTop: 8, background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE', padding: '8px 14px' }}>
                {selectedProductIds.map(id => {
                  const p = products.find(pr => pr.id === id);
                  if (!p) return null;
                  const price = linePrices[id] ?? p.plannedSalePrice ?? p.purchasePrice;
                  const outOfRange = (p.minSalePrice && price < p.minSalePrice) || (p.maxSalePrice && price > p.maxSalePrice);
                  return (
                    <div key={id} className="flex items-center justify-between gap-3" style={{ padding: '8px 0', borderBottom: '1px solid #E5E9EE' }}>
                      <div className="flex-1" style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 13, color: '#0F0F10' }}>{p.brand} {p.name}</span>
                        {(p.minSalePrice || p.maxSalePrice) && (
                          <span style={{ fontSize: 10, color: '#6B7280', display: 'block' }}>
                            Range: {fmt(p.minSalePrice || 0)} — {fmt(p.maxSalePrice || 0)}
                          </span>
                        )}
                        {outOfRange && (
                          <span style={{ fontSize: 10, color: '#AA6E6E', display: 'block' }}>Outside allowed range</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={price}
                          onChange={e => setLinePrices({ ...linePrices, [id]: Number(e.target.value) || 0 })}
                          className="outline-none font-mono"
                          style={{
                            width: 100, textAlign: 'right', padding: '4px 8px', fontSize: 13,
                            background: 'transparent', border: `1px solid ${outOfRange ? '#AA6E6E' : '#D5D9DE'}`,
                            borderRadius: 4, color: '#0F0F10',
                          }}
                        />
                        <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
                      </div>
                    </div>
                  );
                })}
                {/* Total (brutto; VAT is embedded per business rule) */}
                <div style={{ paddingTop: 8, marginTop: 4 }}>
                  <div className="flex justify-between" style={{ fontSize: 15, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
                    <span style={{ color: '#0F0F10' }}>Total</span>
                    <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 500 }}>{fmt(total.total)} BHD</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <Input label="VALID UNTIL" type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              className="w-full outline-none" style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }} />
          </div>

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!selectedCustomerId || selectedProductIds.length === 0}>Create Offer</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
