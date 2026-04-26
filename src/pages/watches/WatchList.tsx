import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { printMultipleHangtags } from '@/core/pdf/hangtag';
import { useProductStore } from '@/stores/productStore';
import { matchesDeep } from '@/core/utils/deep-search';
import { exportExcel } from '@/core/utils/export-file';
import type { Product, TaxScheme, StockStatus, Category } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function htmlEsc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Excel-Export aller (gefilterten) Produkte als formatierte HTML-Tabelle mit MS-Excel MIME.
// Öffnet sich in Excel/Numbers mit echten Spalten + Headern.
function exportProductsToExcel(items: Product[], categories: Category[]) {
  const today = new Date().toISOString().split('T')[0];
  const cat = (id: string) => categories.find(c => c.id === id)?.name || '';
  const headers = [
    'SKU', 'Brand', 'Name', 'Category', 'Quantity', 'Condition',
    'Purchase Price (BHD)', 'Planned Sale Price (BHD)', 'Min Sale (BHD)', 'Max Sale (BHD)',
    'Expected Margin (BHD)', 'Tax Scheme', 'Stock Status', 'Source Type',
    'Storage Location', 'Supplier', 'Purchase Source', 'Paid From', 'Purchase Date',
    'Days in Stock', 'Notes',
  ];
  const rows = items.map(p => [
    p.sku || '',
    p.brand,
    p.name,
    cat(p.categoryId),
    p.quantity || 1,
    p.condition || '',
    p.purchasePrice,
    p.plannedSalePrice ?? '',
    p.minSalePrice ?? '',
    p.maxSalePrice ?? '',
    p.expectedMargin ?? '',
    p.taxScheme === 'MARGIN' ? 'Margin Scheme' : p.taxScheme === 'VAT_10' ? 'VAT 10%' : 'Zero',
    p.stockStatus,
    p.sourceType,
    p.storageLocation || '',
    p.supplierName || '',
    p.purchaseSource || '',
    p.paidFrom || '',
    p.purchaseDate || '',
    p.daysInStock ?? '',
    p.notes || '',
  ]);

  // Totals row (only OWN, in_stock)
  const ownInStock = items.filter(p =>
    (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
  );
  const totalQty = ownInStock.reduce((s, p) => s + (p.quantity || 1), 0);
  const totalEK = ownInStock.reduce((s, p) => s + p.purchasePrice * (p.quantity || 1), 0);
  const totalVK = ownInStock.reduce((s, p) => s + (p.plannedSalePrice || 0) * (p.quantity || 1), 0);

  const html = `<html><head><meta charset="UTF-8">
    <style>
      body { font-family: Calibri, Arial, sans-serif; }
      h2 { color: #0F0F10; margin: 0 0 4px; font-family: Georgia, serif; }
      .meta { color: #6B7280; font-size: 11px; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; }
      th { background: #F2F7FA; color: #0F0F10; font-weight: 600; padding: 8px 10px; text-align: left;
           border: 1px solid #C6A36D; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
      td { border: 1px solid #D5D9DE; padding: 6px 10px; font-size: 12px; }
      tr:nth-child(even) td { background: #FAF8F1; }
      .num { text-align: right; mso-number-format: "#,##0.000"; }
      .total td { background: #0F0F10; color: #FFFFFF; font-weight: 600; }
      .total td.num { color: #FFFFFF; }
    </style></head><body>
    <h2>LATAIF — Collection Export</h2>
    <div class="meta">Generated ${today} · ${items.length} item${items.length !== 1 ? 's' : ''} ·
      Stock value (OWN, In Stock): ${totalEK.toFixed(2)} BHD purchase / ${totalVK.toFixed(2)} BHD planned sale</div>
    <table>
      <thead><tr>${headers.map(h => `<th>${htmlEsc(h)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map(r => `<tr>${r.map((v, i) => {
          const numCol = [4, 6, 7, 8, 9, 10, 19].includes(i);
          return `<td class="${numCol ? 'num' : ''}">${htmlEsc(v)}</td>`;
        }).join('')}</tr>`).join('')}
        <tr class="total">
          <td colspan="4">TOTAL (OWN · In Stock)</td>
          <td class="num">${totalQty}</td>
          <td></td>
          <td class="num">${totalEK.toFixed(2)}</td>
          <td class="num">${totalVK.toFixed(2)}</td>
          <td colspan="${headers.length - 8}"></td>
        </tr>
      </tbody>
    </table>
  </body></html>`;

  exportExcel(`LATAIF_Collection_${today}.xls`, html);
}

export function WatchList() {
  const navigate = useNavigate();
  const {
    products, categories, loadProducts, loadCategories, createProduct,
    searchQuery, setSearchQuery, filterCategory, setFilterCategory,
    filterStatus, setFilterStatus, getStockValue, nextAvailableSku,
  } = useProductStore();
  const [showNew, setShowNew] = useState(false);
  const [selectedCat, setSelectedCat] = useState<Category | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [form, setForm] = useState<Partial<Product>>({
    condition: '', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
  });

  useEffect(() => { loadCategories(); loadProducts(); }, [loadCategories, loadProducts]);

  const filtered = useMemo(() => {
    // Consignment items are excluded from the inventory view by default.
    let r = products.filter(p => p.stockStatus !== 'consignment');
    if (searchQuery) {
      r = r.filter(p => matchesDeep(p, searchQuery, [categories.find(c => c.id === p.categoryId)]));
    }
    if (filterCategory) r = r.filter(p => p.categoryId === filterCategory);
    if (filterStatus) r = r.filter(p => p.stockStatus === filterStatus);
    return r;
  }, [products, searchQuery, filterCategory, filterStatus, categories]);

  const stock = useMemo(() => getStockValue(), [products, getStockValue]);
  const getCat = (id: string) => categories.find(c => c.id === id);

  function openNew(cat?: Category) {
    setSelectedCat(cat || categories[0] || null);
    setForm({
      categoryId: cat?.id || categories[0]?.id || '',
      condition: cat?.conditionOptions?.[0] || '', taxScheme: 'MARGIN',
      scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
    });
    setShowNew(true);
  }

  function handleCreate() {
    if (!form.brand || !form.name || !form.purchasePrice || !form.categoryId) return;
    createProduct(form);
    setShowNew(false);
  }

  function updateAttr(key: string, value: string | number | boolean) {
    setForm({ ...form, attributes: { ...(form.attributes || {}), [key]: value } });
  }

  return (
    <PageLayout
      title="Collection"
      subtitle={`${stock.count} items in stock \u00b7 ${fmt(stock.purchaseTotal)} BHD`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search by brand, name, SKU..."
      actions={
        <div className="flex items-center gap-3">
          {/* Category Filter */}
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            <button onClick={() => setFilterCategory('')}
              className="cursor-pointer transition-all duration-200"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 12,
                border: `1px solid ${!filterCategory ? '#0F0F10' : 'transparent'}`,
                color: !filterCategory ? '#0F0F10' : '#6B7280',
                background: !filterCategory ? 'rgba(15,15,16,0.06)' : 'transparent',
              }}>All</button>
            {categories.map(cat => (
              <button key={cat.id} onClick={() => setFilterCategory(cat.id)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${filterCategory === cat.id ? cat.color : 'transparent'}`,
                  color: filterCategory === cat.id ? cat.color : '#6B7280',
                  background: filterCategory === cat.id ? cat.color + '10' : 'transparent',
                }}>{cat.name}</button>
            ))}
          </div>
          {/* Status Filter */}
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {(['', 'in_stock', 'sold'] as (StockStatus | '')[]).map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '6px 10px', borderRadius: 999, fontSize: 11,
                  border: 'none', background: 'transparent',
                  color: filterStatus === s ? '#0F0F10' : '#6B7280',
                  textDecoration: filterStatus === s ? 'underline' : 'none',
                  textUnderlineOffset: 4,
                }}>{s === '' ? 'Any' : s === 'in_stock' ? 'In Stock' : 'Sold'}</button>
            ))}
          </div>
          <Button variant="ghost" onClick={() => {
            const tags = filtered.map(p => ({
              sku: p.sku || p.id.slice(0, 12),
              brand: p.brand,
              price: p.plannedSalePrice || p.purchasePrice,
              currency: p.purchaseCurrency || 'BHD',
              name: p.name,
              material: String(p.attributes.case_material || p.attributes.material || ''),
              size: String(p.attributes.case_size || p.attributes.size || ''),
              description: String(p.attributes.description_3 || p.condition || ''),
            })).filter(t => t.sku);
            if (tags.length > 0) printMultipleHangtags(tags);
          }}>Print Tags ({filtered.length})</Button>
          <Button variant="ghost" onClick={() => exportProductsToExcel(filtered, categories)}>
            Export Excel ({filtered.length})
          </Button>
          <Button variant="secondary" onClick={() => navigate('/import')}>Import Excel</Button>
          <Button variant="primary" onClick={() => openNew()}>New Item</Button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <Package size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {searchQuery || filterCategory || filterStatus ? 'No items match your filters.' : 'Your collection is empty.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          {filtered.map(p => {
            const cat = getCat(p.categoryId);
            // Show some dynamic attributes in the card
            const showAttrs = cat?.attributes.filter(a => a.showInList) || [];
            const attrText = showAttrs
              .map(a => p.attributes[a.key])
              .filter(Boolean)
              .join(' \u00b7 ');

            return (
              <Card key={p.id} hoverable noPadding onClick={() => navigate(`/collection/${p.id}`)}>
                <div className="flex items-center justify-center relative"
                  style={{ height: 180, background: '#F2F7FA', borderBottom: '1px solid #E5E9EE', overflow: 'hidden' }}>
                  {p.images.length > 0 ? (
                    <img src={p.images[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <Package size={36} strokeWidth={1} style={{ color: '#6B7280' }} />
                  )}
                  {cat && (
                    <span className="absolute" style={{
                      top: 12, left: 12, fontSize: 10, padding: '2px 10px', borderRadius: 999,
                      background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                    }}>{cat.name}</span>
                  )}
                  <span className="absolute" style={{
                    top: 12, right: 12, fontSize: 10, color: '#6B7280',
                    border: '1px solid #D5D9DE', padding: '2px 8px', borderRadius: 999,
                  }}>{p.taxScheme === 'MARGIN' ? 'Margin' : p.taxScheme === 'VAT_10' ? 'Standard VAT' : 'Exempt'}</span>
                </div>
                <div style={{ padding: '18px 22px 22px' }}>
                  <span className="text-overline">{p.brand}</span>
                  <h3 className="font-display" style={{ fontSize: 18, color: '#0F0F10', marginTop: 4, lineHeight: 1.25 }}>{p.name}</h3>
                  {p.sku && <span className="font-mono" style={{ fontSize: 11, color: '#4B5563', display: 'block', marginTop: 3 }}>{p.sku}</span>}
                  {attrText && <span style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 4 }}>{attrText}</span>}
                  <div className="flex items-center justify-between" style={{ marginTop: 16 }}>
                    <span>
                      <span className="font-display" style={{ fontSize: 18, color: '#0F0F10' }}>{fmt(p.plannedSalePrice || p.purchasePrice)}</span>
                      <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>BHD</span>
                      {(p.quantity || 1) > 1 && (
                        <span className="font-mono" style={{
                          marginLeft: 10, fontSize: 11, color: '#AA956E',
                          padding: '2px 8px', border: '1px solid rgba(170,149,110,0.4)',
                          borderRadius: 999,
                        }}>x {p.quantity}</span>
                      )}
                    </span>
                    <StatusDot status={p.stockStatus} />
                  </div>
                  {p.expectedMargin !== undefined && p.expectedMargin > 0 && (
                    <div className="flex items-center justify-between" style={{ marginTop: 8, fontSize: 12 }}>
                      <span style={{ color: '#6B7280' }}>Margin</span>
                      <span className="font-mono" style={{ color: '#7EAA6E' }}>{fmt(p.expectedMargin)} BHD</span>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* New Product Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Item" width={660}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>

          {/* Category Selector */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>CATEGORY</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {categories.map(cat => (
                <button key={cat.id}
                  onClick={() => {
                    setSelectedCat(cat);
                    setForm({ ...form, categoryId: cat.id, condition: cat.conditionOptions?.[0] || '', attributes: {} });
                  }}
                  className="cursor-pointer rounded-lg transition-all duration-200"
                  style={{
                    padding: '10px 18px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${form.categoryId === cat.id ? cat.color : '#D5D9DE'}`,
                    color: form.categoryId === cat.id ? cat.color : '#6B7280',
                    background: form.categoryId === cat.id ? cat.color + '08' : 'transparent',
                  }}>
                  <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Universal Fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="BRAND" placeholder="e.g. Rolex, Hermes, Cartier" value={form.brand || ''} onChange={e => setForm({ ...form, brand: e.target.value })} />
            <Input label="NAME / MODEL" placeholder="e.g. Submariner, Birkin 30" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
            <Input label="SKU / REFERENCE" placeholder="Internal reference" value={form.sku || ''} onChange={e => setForm({ ...form, sku: e.target.value })} />
            <Input label="QUANTITY" type="number" placeholder="1" value={form.quantity || 1}
              onChange={e => setForm({ ...form, quantity: Math.max(1, Number(e.target.value) || 1) })} />
          </div>

          {/* Dynamic Attributes from Category */}
          {selectedCat && selectedCat.attributes.length > 0 && (
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              <span className="text-overline" style={{ marginBottom: 12 }}>{selectedCat.name.toUpperCase()} DETAILS</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
                {selectedCat.attributes.map(attr => {
                  if (attr.type === 'select' && attr.options) {
                    return (
                      <div key={attr.key}>
                        <span className="text-overline" style={{ marginBottom: 6 }}>{attr.label.toUpperCase()}</span>
                        <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                          {attr.options.map(opt => (
                            <button key={opt} onClick={() => updateAttr(attr.key, opt)}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                border: `1px solid ${form.attributes?.[attr.key] === opt ? '#0F0F10' : '#D5D9DE'}`,
                                color: form.attributes?.[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                background: form.attributes?.[attr.key] === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                              }}>{opt}</button>
                          ))}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <Input
                      key={attr.key}
                      label={attr.label.toUpperCase() + (attr.unit ? ` (${attr.unit})` : '')}
                      type={attr.type === 'number' ? 'number' : 'text'}
                      placeholder={attr.label}
                      value={(form.attributes?.[attr.key] as string) || ''}
                      onChange={e => updateAttr(attr.key, attr.type === 'number' ? Number(e.target.value) : e.target.value)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Condition */}
          {selectedCat && selectedCat.conditionOptions.length > 0 && (
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>CONDITION</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {selectedCat.conditionOptions.map(cond => (
                  <button key={cond} onClick={() => setForm({ ...form, condition: cond })}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${form.condition === cond ? '#0F0F10' : '#D5D9DE'}`,
                      color: form.condition === cond ? '#0F0F10' : '#6B7280',
                      background: form.condition === cond ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{cond}</button>
                ))}
              </div>
            </div>
          )}

          {/* Scope */}
          {selectedCat && selectedCat.scopeOptions.length > 0 && (
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>INCLUDED</span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {selectedCat.scopeOptions.map(item => {
                  const sel = (form.scopeOfDelivery || []).includes(item);
                  return (
                    <button key={item}
                      onClick={() => {
                        const s = form.scopeOfDelivery || [];
                        setForm({ ...form, scopeOfDelivery: sel ? s.filter(x => x !== item) : [...s, item] });
                      }}
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

          {/* Plan §Product §4: AI-Identify füllt alle Kategorie-Felder für ALLE Kategorien aus. */}
          {form.categoryId && (
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                <div>
                  <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                    Fills brand, name, all category attributes, condition, market value, description — you can still edit anything after.
                  </div>
                </div>
                <button
                  disabled={aiBusy}
                  className="cursor-pointer transition-colors"
                  style={{
                    background: aiBusy ? '#6B7280' : '#0F0F10', color: '#FFFFFF',
                    border: 'none', borderRadius: 8, fontSize: 12, padding: '8px 14px',
                  }}
                  onClick={async () => {
                    const ai = await import('@/core/ai/ai-service');
                    if (!ai.isAiConfigured()) { alert('Set OpenAI API key in Settings > AI'); return; }
                    if (!form.categoryId) { alert('Select a category first'); return; }
                    const hasImage = (form.images || []).length > 0;
                    const hasHints = !!form.brand || !!form.name || !!form.sku;
                    if (!hasImage && !hasHints) {
                      alert('Add a photo OR type a brand/name/reference hint first, then click AI Identify.');
                      return;
                    }
                    setAiBusy(true);
                    try {
                      const result = await ai.identifyProduct({
                        categoryId: form.categoryId as AiCategoryId,
                        imageBase64: hasImage ? form.images![0] : undefined,
                        hints: hasHints ? { brand: form.brand, name: form.name, reference: form.sku } : undefined,
                      });
                      setForm(f => {
                        const updated = { ...f };
                        if (result.brand) updated.brand = result.brand;
                        if (result.name) updated.name = result.name;
                        if (result.sku && !f.sku) updated.sku = nextAvailableSku(result.sku);
                        if (result.condition) updated.condition = result.condition;
                        if (result.description) updated.notes = f.notes ? `${f.notes}\n\n${result.description}` : result.description;
                        if (result.estimatedValue && !f.plannedSalePrice) updated.plannedSalePrice = result.estimatedValue;
                        if (result.purchasePriceEstimate && !f.purchasePrice) updated.purchasePrice = result.purchasePriceEstimate;
                        if (result.minSalePrice && !f.minSalePrice) updated.minSalePrice = result.minSalePrice;
                        if (result.maxSalePrice && !f.maxSalePrice) updated.maxSalePrice = result.maxSalePrice;
                        if (result.taxScheme && !f.taxScheme) updated.taxScheme = result.taxScheme;
                        if (result.storageLocation && !f.storageLocation) updated.storageLocation = result.storageLocation;
                        if (Array.isArray(result.scopeOfDelivery) && result.scopeOfDelivery.length > 0 && (!f.scopeOfDelivery || f.scopeOfDelivery.length === 0)) {
                          updated.scopeOfDelivery = result.scopeOfDelivery;
                        }
                        // Kategorie-Attribute — Merge, Skalare/Booleans direkt übernehmen
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

          {/* Images */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span className="text-overline">PHOTOS</span>
              <span style={{ fontSize: 11, color: '#6B7280' }}>Add at least one photo for best AI results</span>
            </div>
            <div style={{ marginTop: 0 }}>
              <ImageUpload images={form.images || []} onChange={imgs => setForm({ ...form, images: imgs })} maxImages={6} />
            </div>
          </div>

          {/* Pricing */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 12 }}>PRICING</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
              <Input label="PURCHASE PRICE (BHD)" type="number" placeholder="0" value={form.purchasePrice || ''} onChange={e => setForm({ ...form, purchasePrice: Number(e.target.value) || 0 })} />
              <Input label="SALE PRICE (BHD)" type="number" placeholder="0" value={form.plannedSalePrice || ''} onChange={e => setForm({ ...form, plannedSalePrice: Number(e.target.value) || undefined })} />
              <Input label="MIN SALE PRICE (BHD)" type="number" placeholder="Sales floor" value={form.minSalePrice || ''} onChange={e => setForm({ ...form, minSalePrice: Number(e.target.value) || undefined })} />
              <Input label="MAX SALE PRICE (BHD)" type="number" placeholder="Sales ceiling" value={form.maxSalePrice || ''} onChange={e => setForm({ ...form, maxSalePrice: Number(e.target.value) || undefined })} />
            </div>
            {form.purchasePrice && form.plannedSalePrice && (
              <div className="rounded font-mono" style={{
                marginTop: 12, padding: 12, background: '#F2F7FA', border: '1px solid #E5E9EE',
                fontSize: 13, display: 'flex', justifyContent: 'space-between',
              }}>
                <span style={{ color: '#6B7280' }}>Expected Margin</span>
                <span style={{ color: (form.plannedSalePrice - form.purchasePrice) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                  {fmt(form.plannedSalePrice - form.purchasePrice)} BHD ({((form.plannedSalePrice - form.purchasePrice) / form.purchasePrice * 100).toFixed(1)}%)
                </span>
              </div>
            )}
          </div>

          {/* Tax Scheme */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>TAX SCHEME</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(scheme => (
                <button key={scheme} onClick={() => setForm({ ...form, taxScheme: scheme })}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${form.taxScheme === scheme ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.taxScheme === scheme ? '#0F0F10' : '#6B7280',
                    background: form.taxScheme === scheme ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{scheme === 'MARGIN' ? 'Margin' : scheme === 'VAT_10' ? 'VAT 10%' : 'Zero'}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="STORAGE LOCATION" placeholder="Safe, Shelf, Display..." value={form.storageLocation || ''} onChange={e => setForm({ ...form, storageLocation: e.target.value })} />
            <Input label="SUPPLIER" placeholder="Supplier name" value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="PURCHASE SOURCE" placeholder="Souq, Private seller, Auction..." value={form.purchaseSource || ''} onChange={e => setForm({ ...form, purchaseSource: e.target.value })} />
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>PAID FROM</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {([null, 'cash', 'bank'] as const).map(opt => {
                  const active = (form.paidFrom ?? null) === opt;
                  const label = opt === null ? 'None' : opt === 'cash' ? 'Cash' : 'Bank';
                  return (
                    <button key={String(opt)} type="button" onClick={() => setForm({ ...form, paidFrom: opt })}
                      className="cursor-pointer rounded transition-all duration-200"
                      style={{
                        padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{label}</button>
                  );
                })}
              </div>
            </div>
          </div>
          {form.paidFrom && form.purchasePrice ? (
            <div className="rounded font-mono" style={{
              padding: 12, background: '#F2F7FA', border: '1px solid #E5E9EE',
              fontSize: 12, color: '#6B7280', display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Will deduct from {form.paidFrom === 'cash' ? 'Cash' : 'Bank'}</span>
              <span style={{ color: '#AA6E6E' }}>− {fmt(form.purchasePrice)} BHD</span>
            </div>
          ) : null}

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}>Add to Collection</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
