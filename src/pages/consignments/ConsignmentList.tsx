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
import { ImageUpload } from '@/components/ui/ImageUpload';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { ConsignmentStatus, Product, Category, TaxScheme } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';

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
  const { products, loadProducts, categories, loadCategories, createProduct, nextAvailableSku } = useProductStore();

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

  // New consignment form (Consignor + Konditionen — Produktdaten kommen aus productForm).
  const [form, setForm] = useState({
    consignorId: '',
    agreedPrice: '',
    minimumPrice: '',
    commissionRate: '15',
    expiryDate: '',
    notes: '',
    consignorSearch: '',
  });

  // Plan §Consignment §New: Das Produkt wird beim Anlegen NEU erfasst (Kundenware), nicht
  // aus dem eigenen Lager gewählt. Layout/Felder identisch zu Collection > New Item, aber
  // ohne Einkaufspreis/Paid-From/Supplier (wir kaufen das Stück nicht — es bleibt Eigentum
  // des Consignors bis zum Verkauf).
  const [selectedCat, setSelectedCat] = useState<Category | null>(null);
  const [productForm, setProductForm] = useState<Partial<Product>>({
    condition: '', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
  });
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    loadConsignments();
    loadCustomers();
    loadProducts();
    loadCategories();
  }, [loadConsignments, loadCustomers, loadProducts, loadCategories]);

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
      consignorId: '',
      agreedPrice: '', minimumPrice: '', commissionRate: '15',
      expiryDate: '', notes: '', consignorSearch: '',
    });
    const firstCat = categories[0] || null;
    setSelectedCat(firstCat);
    setProductForm({
      categoryId: firstCat?.id || '',
      condition: firstCat?.conditionOptions?.[0] || '',
      taxScheme: 'MARGIN',
      scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
      images: [],
    });
    setShowNew(true);
  }

  function updateAttr(key: string, value: string | number | boolean) {
    setProductForm(p => ({ ...p, attributes: { ...(p.attributes || {}), [key]: value } }));
  }

  function handleCreate() {
    // Pflicht: Consignor + Kategorie + Brand + Name. Rest darf Quick-Capture-Style leer sein.
    if (!form.consignorId) return;
    if (!productForm.categoryId || !productForm.brand || !productForm.name) return;

    // Schritt 1: Produkt anlegen — als Consignment-Ware (kein Einkauf von uns).
    const newProduct = createProduct({
      ...productForm,
      purchasePrice: 0,           // wir bezahlen nichts an den Consignor beim Intake
      stockStatus: 'consignment', // raus aus normalem Lager-Filter
      sourceType: 'CONSIGNMENT',
      quantity: 1,
    });

    // Schritt 2: Consignment-Vertrag verknüpfen.
    const rateVal = Number(form.commissionRate) || 0;
    createConsignment({
      consignorId: form.consignorId,
      productId: newProduct.id,
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
              <tr style={{ borderBottom: '1px solid #E5E9EE' }}>
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
                    style={{ borderBottom: '1px solid #E5E9EE' }}
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
                                border: '1px solid #D5D9DE', color: '#7EAA6E',
                                background: 'transparent',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(126,170,110,0.08)'; e.currentTarget.style.borderColor = '#7EAA6E'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D9DE'; }}
                            >Sold</button>
                            <button
                              onClick={() => markReturned(con.id)}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 6,
                                border: '1px solid #D5D9DE', color: '#6B7280',
                                background: 'transparent',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = '#6B7280'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D9DE'; }}
                            >Return</button>
                          </>
                        )}
                        {con.status === 'sold' && (
                          <button
                            onClick={() => setPaidModal(con.id)}
                            className="cursor-pointer transition-all duration-200"
                            style={{
                              padding: '4px 10px', fontSize: 11, borderRadius: 6,
                              border: '1px solid #D5D9DE', color: '#0F0F10',
                              background: 'transparent',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(15,15,16,0.08)'; e.currentTarget.style.borderColor = '#0F0F10'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D9DE'; }}
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

          {/* Plan §Consignment §New: Item wird hier neu erfasst — wie Collection > New Item.
              Kein Picker auf eigene Inventar-Produkte. */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
              CONSIGNED ITEM
            </span>
            <div style={{
              padding: '8px 12px', borderRadius: 8, background: '#F2F7FA',
              border: '1px solid #E5E9EE', color: '#6B7280', fontSize: 12, lineHeight: 1.5,
              marginBottom: 16,
            }}>
              <strong style={{ color: '#0F0F10' }}>Customer-owned item:</strong> Wird neu erfasst, gehört dem
              Consignor bis zum Verkauf. Kein Eigeninventar.
            </div>

            {/* Kategorie */}
            <div style={{ marginBottom: 16 }}>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
                CATEGORY <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
              </span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {categories.map(cat => (
                  <button key={cat.id}
                    onClick={() => {
                      setSelectedCat(cat);
                      setProductForm(p => ({ ...p, categoryId: cat.id, condition: cat.conditionOptions?.[0] || '', attributes: {} }));
                    }}
                    className="cursor-pointer rounded-lg transition-all duration-200"
                    style={{
                      padding: '10px 18px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
                      border: `1px solid ${productForm.categoryId === cat.id ? cat.color : '#D5D9DE'}`,
                      color: productForm.categoryId === cat.id ? cat.color : '#6B7280',
                      background: productForm.categoryId === cat.id ? cat.color + '08' : 'transparent',
                    }}>
                    <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Brand + Name */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Input required label="BRAND" placeholder="e.g. Rolex, Hermes, Cartier"
                value={productForm.brand || ''}
                onChange={e => setProductForm(p => ({ ...p, brand: e.target.value }))} />
              <Input required label="NAME / MODEL" placeholder="e.g. Submariner, Birkin 30"
                value={productForm.name || ''}
                onChange={e => setProductForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div style={{ marginTop: 16 }}>
              <Input label="SKU / REFERENCE" placeholder="Internal reference"
                value={productForm.sku || ''}
                onChange={e => setProductForm(p => ({ ...p, sku: e.target.value }))} />
            </div>

            {/* Dynamische Kategorie-Attribute */}
            {selectedCat && selectedCat.attributes.length > 0 && (
              <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16, marginTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 12 }}>{selectedCat.name.toUpperCase()} DETAILS</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
                  {selectedCat.attributes.map(attr => {
                    if (attr.type === 'select' && attr.options) {
                      return (
                        <div key={attr.key}>
                          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                            {attr.label.toUpperCase()}
                            {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                          </span>
                          <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                            {attr.options.map(opt => (
                              <button key={opt} onClick={() => updateAttr(attr.key, opt)}
                                className="cursor-pointer transition-all duration-200"
                                style={{
                                  padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                  border: `1px solid ${productForm.attributes?.[attr.key] === opt ? '#0F0F10' : '#D5D9DE'}`,
                                  color: productForm.attributes?.[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                  background: productForm.attributes?.[attr.key] === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                                }}>{opt}</button>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={attr.key}>
                        <Input
                          required={attr.required}
                          label={attr.label.toUpperCase() + (attr.unit ? ` (${attr.unit})` : '')}
                          type={attr.type === 'number' ? 'number' : 'text'}
                          placeholder={attr.label}
                          value={(productForm.attributes?.[attr.key] as string) || ''}
                          onChange={e => updateAttr(attr.key, attr.type === 'number' ? Number(e.target.value) : e.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Condition */}
            {selectedCat && selectedCat.conditionOptions.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
                  CONDITION <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
                </span>
                <div className="flex gap-2" style={{ marginTop: 8 }}>
                  {selectedCat.conditionOptions.map(cond => (
                    <button key={cond} onClick={() => setProductForm(p => ({ ...p, condition: cond }))}
                      className="cursor-pointer rounded transition-all duration-200"
                      style={{
                        padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${productForm.condition === cond ? '#0F0F10' : '#D5D9DE'}`,
                        color: productForm.condition === cond ? '#0F0F10' : '#6B7280',
                        background: productForm.condition === cond ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{cond}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Scope / Included */}
            {selectedCat && selectedCat.scopeOptions.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 8 }}>INCLUDED</span>
                <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                  {selectedCat.scopeOptions.map(item => {
                    const sel = (productForm.scopeOfDelivery || []).includes(item);
                    return (
                      <button key={item}
                        onClick={() => setProductForm(p => {
                          const s = p.scopeOfDelivery || [];
                          return { ...p, scopeOfDelivery: sel ? s.filter(x => x !== item) : [...s, item] };
                        })}
                        className="cursor-pointer transition-all duration-200"
                        style={{
                          padding: '5px 12px', fontSize: 11, borderRadius: 999,
                          border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                          color: sel ? '#0F0F10' : '#6B7280',
                          background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{item}</button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* AI Identify */}
            {productForm.categoryId && (
              <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16, marginTop: 16 }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                  <div>
                    <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                    <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                      Füllt Brand, Name, Kategorie-Felder, Description automatisch — alles editierbar.
                    </div>
                  </div>
                  <button disabled={aiBusy}
                    className="cursor-pointer transition-colors"
                    style={{
                      background: aiBusy ? '#6B7280' : '#0F0F10', color: '#FFFFFF',
                      border: 'none', borderRadius: 8, fontSize: 12, padding: '8px 14px',
                    }}
                    onClick={async () => {
                      const ai = await import('@/core/ai/ai-service');
                      if (!ai.isAiConfigured()) { alert('Set OpenAI API key in Settings > AI'); return; }
                      const hasImage = (productForm.images || []).length > 0;
                      const hasHints = !!productForm.brand || !!productForm.name || !!productForm.sku;
                      if (!hasImage && !hasHints) {
                        alert('Add a photo OR type a brand/name/reference hint first, then click AI Identify.');
                        return;
                      }
                      setAiBusy(true);
                      try {
                        const result = await ai.identifyProduct({
                          categoryId: productForm.categoryId as AiCategoryId,
                          imageBase64: hasImage ? productForm.images![0] : undefined,
                          hints: hasHints ? { brand: productForm.brand, name: productForm.name, reference: productForm.sku } : undefined,
                        });
                        setProductForm(f => {
                          const updated = { ...f };
                          if (result.brand) updated.brand = result.brand;
                          if (result.name) updated.name = result.name;
                          if (result.sku && !f.sku) updated.sku = nextAvailableSku(result.sku);
                          if (result.condition) updated.condition = result.condition;
                          if (result.description) updated.notes = f.notes ? `${f.notes}\n\n${result.description}` : result.description;
                          if (result.estimatedValue && !form.agreedPrice) {
                            // Plan §Consignment: AI-Schätzung schreibt nicht ins Produkt sondern in
                            // den Consignment-Agreed-Price-Vorschlag, da das Produkt selbst keinen Sale Price hat.
                            setForm(prev => ({ ...prev, agreedPrice: String(result.estimatedValue) }));
                          }
                          if (result.taxScheme && !f.taxScheme) updated.taxScheme = result.taxScheme;
                          if (Array.isArray(result.scopeOfDelivery) && result.scopeOfDelivery.length > 0 && (!f.scopeOfDelivery || f.scopeOfDelivery.length === 0)) {
                            updated.scopeOfDelivery = result.scopeOfDelivery;
                          }
                          const attrs = { ...(f.attributes || {}) };
                          for (const [k, v] of Object.entries(result.attributes || {})) {
                            if (v === null || v === undefined || v === '') continue;
                            attrs[k] = v as string | number | boolean | string[];
                          }
                          updated.attributes = attrs;
                          return updated;
                        });
                      } catch (e) { alert(String(e)); }
                      finally { setAiBusy(false); }
                    }}
                  >{aiBusy ? 'Researching…' : 'AI Identify'}</button>
                </div>
              </div>
            )}

            {/* Photos */}
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16, marginTop: 16 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                <span className="text-overline">PHOTOS</span>
                <span style={{ fontSize: 11, color: '#6B7280' }}>Add at least one photo for best AI results</span>
              </div>
              <ImageUpload images={productForm.images || []}
                onChange={imgs => setProductForm(p => ({ ...p, images: imgs }))}
                maxImages={6} />
            </div>

            {/* Tax Scheme + Storage Location */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>TAX SCHEME</span>
                <div className="flex gap-2" style={{ marginTop: 8 }}>
                  {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(scheme => (
                    <button key={scheme} onClick={() => setProductForm(p => ({ ...p, taxScheme: scheme }))}
                      className="cursor-pointer rounded transition-all duration-200"
                      style={{
                        padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${productForm.taxScheme === scheme ? '#0F0F10' : '#D5D9DE'}`,
                        color: productForm.taxScheme === scheme ? '#0F0F10' : '#6B7280',
                        background: productForm.taxScheme === scheme ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{scheme === 'MARGIN' ? 'Margin' : scheme === 'VAT_10' ? 'VAT 10%' : 'Zero'}</button>
                  ))}
                </div>
              </div>
              <Input label="STORAGE LOCATION" placeholder="Safe, Shelf, Display..."
                value={productForm.storageLocation || ''}
                onChange={e => setProductForm(p => ({ ...p, storageLocation: e.target.value }))} />
            </div>
          </div>

          {/* Pricing */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
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
                      border: `1px solid ${commissionType === t ? '#0F0F10' : '#D5D9DE'}`,
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
                marginTop: 16, padding: 16, background: '#F2F7FA',
                border: '1px solid #E5E9EE', fontSize: 13,
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
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
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
                borderBottom: '1px solid #D5D9DE', border: 'none',
                borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: '#D5D9DE',
                padding: '10px 0', fontSize: 14, color: '#0F0F10',
                resize: 'vertical', minHeight: 60,
              }}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => (e.currentTarget.style.borderBottomColor = '#D5D9DE')}
            />
          </div>

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}
              disabled={!form.consignorId || !productForm.categoryId || !productForm.brand || !productForm.name}
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
          <Input required label="SALE PRICE (BHD)" type="number" placeholder="0"
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
                padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
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
                    border: `1px solid ${soldSaleMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: soldSaleMethod === m ? '#0F0F10' : '#6B7280',
                    background: soldSaleMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
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
                padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
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
            <Button variant="ghost" onClick={() => setPaidModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleMarkPaid}>Confirm Payout</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
