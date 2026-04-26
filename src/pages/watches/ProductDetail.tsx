import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Package, Trash2, Save, Tag, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { useProductStore } from '@/stores/productStore';
import { usePermission } from '@/hooks/usePermission';
import { vatEngine } from '@/core/tax/vat-engine';
import { printHangtag } from '@/core/pdf/hangtag';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import type { Product, TaxScheme, StockStatus } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { products, categories, loadProducts, loadCategories, updateProduct, deleteProduct, nextAvailableSku } = useProductStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Product>>({});
  const [formAttrs, setFormAttrs] = useState<Record<string, string | number | boolean | string[]>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const perm = usePermission();

  useEffect(() => { loadCategories(); loadProducts(); }, [loadCategories, loadProducts]);

  const product = useMemo(() => products.find(p => p.id === id), [products, id]);
  // Im Edit-Mode: Kategorie aus form.categoryId → Felder passen sich live an.
  // Im Read-Mode: Kategorie aus product.categoryId.
  const category = useMemo(() => {
    const cid = editing ? form.categoryId : product?.categoryId;
    return cid ? categories.find(c => c.id === cid) : null;
  }, [product, categories, editing, form.categoryId]);

  useEffect(() => {
    if (product) {
      setForm({ ...product });
      setFormAttrs({ ...product.attributes });
    }
  }, [product]);

  if (!product) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Product not found</p>
      </div>
    );
  }

  const taxCalc = product.plannedSalePrice
    ? vatEngine.calculateProfit(product.plannedSalePrice, product.purchasePrice, product.taxScheme, 10)
    : null;

  function handleSave() {
    if (!id) return;
    const margin = form.plannedSalePrice ? form.plannedSalePrice - (form.purchasePrice || 0) : undefined;
    updateProduct(id, {
      ...form,
      attributes: formAttrs,
      expectedMargin: margin,
    });
    setEditing(false);
  }

  function handleDelete() {
    if (!id) return;
    deleteProduct(id);
    navigate('/collection');
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
          <button onClick={() => navigate('/collection')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Collection
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...product }); setFormAttrs({ ...product.attributes }); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={async () => {
                  if (!product) return;
                  const ai = await import('@/core/ai/ai-service');
                  if (!ai.isAiConfigured()) { setAiResult('Set your OpenAI API key in Settings > AI'); return; }
                  setAiLoading(true); setAiResult(null);
                  try {
                    const result = await ai.suggestPrice({ brand: product.brand, name: product.name, condition: product.condition, purchasePrice: product.purchasePrice, attributes: product.attributes });
                    setAiResult(`Suggested: ${result.suggestedPrice} BHD (${result.minPrice}-${result.maxPrice})\n${result.reasoning}`);
                  } catch (e) { setAiResult(String(e)); }
                  setAiLoading(false);
                }} disabled={aiLoading}><Sparkles size={14} /> {aiLoading ? 'Analyzing...' : 'AI Price'}</Button>
                {perm.canEditProducts && <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>}
                <Button variant="ghost" onClick={() => {
                  if (!product) return;
                  const mat = (product.attributes.case_material || product.attributes.material || product.attributes.metal || '') as string;
                  const sz = (product.attributes.case_size || product.attributes.size || product.attributes.size_eu || '') as string;
                  const desc = (product.attributes.description_3 || product.condition || '') as string;
                  printHangtag({
                    sku: product.sku || product.id.slice(0, 12),
                    brand: product.brand,
                    price: product.plannedSalePrice || product.purchasePrice,
                    currency: product.purchaseCurrency || 'BHD',
                    name: product.name,
                    material: mat ? String(mat) : undefined,
                    size: sz ? String(sz) : undefined,
                    description: desc ? String(desc) : undefined,
                  });
                }}><Tag size={14} /> Hangtag</Button>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                <Button variant="primary" onClick={() => navigate(`/offers?product=${id}`)}>Create Offer</Button>
              </>
            )}
          </div>
        </div>

        {/* AI Result */}
        {aiResult && (
          <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 8, background: 'rgba(15,15,16,0.06)', border: '1px solid rgba(15,15,16,0.15)' }}>
            <div className="flex justify-between">
              <span style={{ fontSize: 12, color: '#0F0F10', fontWeight: 500 }}>AI Suggestion</span>
              <button onClick={() => setAiResult(null)} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 11 }}>close</button>
            </div>
            <p style={{ fontSize: 13, color: '#0F0F10', marginTop: 6, whiteSpace: 'pre-wrap' }}>{aiResult}</p>
          </div>
        )}

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>
          {/* Image */}
          <div className="rounded-xl" style={{ minHeight: 400, background: '#F2F7FA', border: '1px solid #E5E9EE', overflow: 'hidden' }}>
            {editing ? (
              <div style={{ padding: 20 }}>
                <span className="text-overline" style={{ marginBottom: 12 }}>PHOTOS</span>
                <div style={{ marginTop: 12 }}>
                  <ImageUpload images={form.images || []} onChange={imgs => setForm({ ...form, images: imgs })} maxImages={8} />
                </div>
                {/* Plan §Product §4: AI-Identify auch im Edit-Mode (z.B. für mobile-erfasste Produkte ohne KI). */}
                <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                    <div>
                      <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                        Füllt Brand, Name, Kategorie-Felder, Condition, Marktwert aus dem Foto oder Hints (Brand/Name/SKU).
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
                        if (!form.categoryId) { alert('Kein category_id — bitte erst eine Kategorie zuweisen.'); return; }
                        const hasImage = (form.images || []).length > 0;
                        const hasHints = !!form.brand || !!form.name || !!form.sku;
                        if (!hasImage && !hasHints) {
                          alert('Foto oder Brand/Name/SKU eintragen, dann AI Identify klicken.');
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
                            return updated;
                          });
                          // Kategorie-Attribute in formAttrs mergen (separater state in ProductDetail)
                          setFormAttrs(a => {
                            const next = { ...a };
                            for (const [k, v] of Object.entries(result.attributes || {})) {
                              if (v === null || v === undefined || v === '') continue;
                              next[k] = v as string | number | boolean | string[];
                            }
                            return next;
                          });
                        } catch (e) { alert(String(e)); }
                        finally { setAiBusy(false); }
                      }}
                    >{aiBusy ? 'Researching…' : 'AI Identify'}</button>
                  </div>
                </div>
              </div>
            ) : product.images.length > 0 ? (
              <img src={product.images[0]} alt="" style={{ width: '100%', height: 400, objectFit: 'cover' }} />
            ) : (
              <div className="flex items-center justify-center" style={{ height: 400 }}>
                <Package size={64} strokeWidth={0.8} style={{ color: '#6B7280' }} />
              </div>
            )}
            {!editing && product.images.length > 1 && (
              <div className="flex gap-2" style={{ padding: '8px 12px', borderTop: '1px solid #E5E9EE' }}>
                {product.images.slice(1, 5).map((img, i) => (
                  <div key={i} className="rounded" style={{ width: 56, height: 56, overflow: 'hidden', border: '1px solid #E5E9EE' }}>
                    <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))}
                {product.images.length > 5 && (
                  <div className="rounded flex items-center justify-center" style={{ width: 56, height: 56, background: '#FFFFFF', border: '1px solid #E5E9EE', fontSize: 11, color: '#6B7280' }}>
                    +{product.images.length - 5}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Key Info */}
          <div>
            {category && (
              <span style={{ fontSize: 11, padding: '3px 12px', borderRadius: 999, background: category.color + '15', color: category.color, border: `1px solid ${category.color}30`, display: 'inline-block', marginBottom: 16 }}>{category.name}</span>
            )}

            {editing ? (
              <>
                {/* Category Selector — wechseln bewirkt dass sich die "Specifications"-Karte unten anpasst. */}
                <div style={{ marginBottom: 16 }}>
                  <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>CATEGORY</span>
                  <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                    {categories.map(cat => {
                      const active = form.categoryId === cat.id;
                      return (
                        <button key={cat.id} onClick={() => {
                          // Beim Wechsel: Attributes zurücksetzen — alte Werte würden eh keine passenden Spalten mehr haben.
                          setForm({
                            ...form,
                            categoryId: cat.id,
                            condition: active ? form.condition : (cat.conditionOptions?.[0] || ''),
                          });
                          if (!active) setFormAttrs({});
                        }}
                          className="cursor-pointer rounded-lg transition-all"
                          style={{
                            padding: '8px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                            border: `1px solid ${active ? cat.color : '#D5D9DE'}`,
                            color: active ? cat.color : '#6B7280',
                            background: active ? cat.color + '08' : 'transparent',
                          }}>
                          <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                          {cat.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <Input label="BRAND" value={form.brand || ''} onChange={e => setForm({ ...form, brand: e.target.value })} />
                <Input label="NAME / MODEL" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
                <Input label="SKU / REFERENCE" value={form.sku || ''} onChange={e => setForm({ ...form, sku: e.target.value })} />
                <Input label="QUANTITY (STÜCKZAHL)" type="number" min="0"
                  value={form.quantity ?? 1}
                  onChange={e => setForm({ ...form, quantity: Math.max(0, Number(e.target.value) || 0) })} />
                <div>
                  <span className="text-overline" style={{ marginBottom: 6 }}>STATUS</span>
                  <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                    {(['in_stock', 'reserved', 'offered', 'sold', 'consignment'] as StockStatus[]).map(s => (
                      <button key={s} onClick={() => setForm({ ...form, stockStatus: s })}
                        className="cursor-pointer" style={{
                          padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                          background: form.stockStatus === s ? 'rgba(15,15,16,0.1)' : 'transparent',
                          color: form.stockStatus === s ? '#0F0F10' : '#6B7280',
                        }}>{s.replace('_', ' ')}</button>
                    ))}
                  </div>
                </div>
              </div>
              </>
            ) : (
              <>
                <span className="text-overline">{product.brand}</span>
                <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>{product.name}</h1>
                {product.sku && <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 8 }}>{product.sku}</span>}
                <div className="flex items-center gap-4" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  <StatusDot status={product.stockStatus} />
                  {(product.quantity || 1) > 1 && (
                    <span className="font-mono" style={{
                      fontSize: 12, color: '#AA956E',
                      padding: '3px 10px', border: '1px solid rgba(170,149,110,0.4)',
                      borderRadius: 999,
                    }}>x {product.quantity}</span>
                  )}
                  {product.condition && <span style={{ fontSize: 13, color: '#4B5563' }}>{product.condition}</span>}
                </div>
              </>
            )}

            {/* Prices */}
            <div style={{ marginTop: 28, borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              {editing ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Input label="PURCHASE PRICE (BHD)" type="number" value={form.purchasePrice || ''} onChange={e => setForm({ ...form, purchasePrice: Number(e.target.value) })} />
                  <Input label="SALE PRICE (BHD)" type="number" value={form.plannedSalePrice || ''} onChange={e => setForm({ ...form, plannedSalePrice: Number(e.target.value) || undefined })} />
                  <Input label="MIN SALE PRICE (BHD)" type="number" value={form.minSalePrice || ''} onChange={e => setForm({ ...form, minSalePrice: Number(e.target.value) || undefined })} />
                  <Input label="MAX SALE PRICE (BHD)" type="number" value={form.maxSalePrice || ''} onChange={e => setForm({ ...form, maxSalePrice: Number(e.target.value) || undefined })} />
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">PURCHASE PRICE</span>
                    <span className="font-display" style={{ fontSize: 20, color: '#4B5563' }}>{fmt(product.purchasePrice)} BHD</span>
                  </div>
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">ASKING PRICE</span>
                    <span className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}>{fmt(product.plannedSalePrice || 0)} BHD</span>
                  </div>
                  {(product.minSalePrice || product.maxSalePrice) && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">SALES RANGE</span>
                      <span className="font-mono" style={{ fontSize: 14, color: '#AA956E' }}>
                        {fmt(product.minSalePrice || 0)} — {fmt(product.maxSalePrice || product.plannedSalePrice || 0)} BHD
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">EXPECTED MARGIN</span>
                    <span className="font-mono" style={{ fontSize: 16, color: (product.expectedMargin || 0) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                      {fmt(product.expectedMargin || 0)} BHD
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Tax */}
            <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div className="flex justify-between items-center" style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: '#6B7280' }}>Tax Scheme</span>
                {editing ? (
                  <div className="flex gap-1">
                    {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(s => (
                      <button key={s} onClick={() => setForm({ ...form, taxScheme: s })}
                        className="cursor-pointer" style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: 'none', background: form.taxScheme === s ? 'rgba(15,15,16,0.1)' : 'transparent', color: form.taxScheme === s ? '#0F0F10' : '#6B7280' }}>{s === 'VAT_10' ? 'VAT 10%' : s}</button>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: '#0F0F10' }}>{product.taxScheme === 'MARGIN' ? 'Margin Scheme' : product.taxScheme === 'VAT_10' ? 'Standard VAT' : 'Exempt'}</span>
                )}
              </div>
              {taxCalc && !editing && (
                <>
                  <div className="flex justify-between" style={{ fontSize: 12 }}>
                    <span style={{ color: '#6B7280' }}>VAT Liability</span>
                    <span className="font-mono" style={{ color: '#AA956E' }}>{fmt(taxCalc.vatLiability)} BHD</span>
                  </div>
                  <div className="flex justify-between" style={{ fontSize: 12, marginTop: 2 }}>
                    <span style={{ color: '#6B7280' }}>Net Profit</span>
                    <span className="font-mono" style={{ color: taxCalc.netProfit >= 0 ? '#7EAA6E' : '#AA6E6E' }}>{fmt(taxCalc.netProfit)} BHD</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Details Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Category-specific Attributes */}
          {category && category.attributes.length > 0 && (
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>SPECIFICATIONS</span>
              <div style={{ marginTop: 16 }}>
                {category.attributes.map(attr => {
                  const val = editing ? formAttrs[attr.key] : product.attributes[attr.key];

                  if (editing) {
                    // Editable
                    if (attr.type === 'select' && attr.options) {
                      return (
                        <div key={attr.key} style={{ padding: '8px 0', borderBottom: '1px solid #E5E9EE' }}>
                          <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 4 }}>{attr.label}</span>
                          <div className="flex flex-wrap gap-1">
                            {attr.options.map(opt => (
                              <button key={opt} onClick={() => setFormAttrs({ ...formAttrs, [attr.key]: opt })}
                                className="cursor-pointer" style={{
                                  padding: '3px 8px', fontSize: 11, borderRadius: 4, border: 'none',
                                  background: formAttrs[attr.key] === opt ? 'rgba(15,15,16,0.1)' : 'transparent',
                                  color: formAttrs[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                }}>{opt}</button>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={attr.key} style={{ padding: '6px 0', borderBottom: '1px solid #E5E9EE' }}>
                        <Input
                          label={attr.label + (attr.unit ? ` (${attr.unit})` : '')}
                          type={attr.type === 'number' ? 'number' : 'text'}
                          value={String(formAttrs[attr.key] || '')}
                          onChange={e => setFormAttrs({ ...formAttrs, [attr.key]: attr.type === 'number' ? Number(e.target.value) : e.target.value })}
                        />
                      </div>
                    );
                  }

                  // Read-only
                  if (!val && val !== 0) return null;
                  return (
                    <div key={attr.key} className="flex justify-between" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
                      <span style={{ fontSize: 13, color: '#6B7280' }}>{attr.label}</span>
                      <span style={{ fontSize: 13, color: '#0F0F10' }}>{String(val)}{attr.unit ? ` ${attr.unit}` : ''}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* General Details */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>DETAILS</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Condition */}
                  {category && category.conditionOptions.length > 0 && (
                    <div>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Condition</span>
                      <div className="flex flex-wrap gap-1">
                        {category.conditionOptions.map(c => (
                          <button key={c} onClick={() => setForm({ ...form, condition: c })}
                            className="cursor-pointer" style={{
                              padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                              background: form.condition === c ? 'rgba(15,15,16,0.1)' : 'transparent',
                              color: form.condition === c ? '#0F0F10' : '#6B7280',
                            }}>{c}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Scope */}
                  {category && category.scopeOptions.length > 0 && (
                    <div>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Scope of Delivery</span>
                      <div className="flex flex-wrap gap-1">
                        {category.scopeOptions.map(s => {
                          const sel = (form.scopeOfDelivery || []).includes(s);
                          return (
                            <button key={s} onClick={() => {
                              const arr = form.scopeOfDelivery || [];
                              setForm({ ...form, scopeOfDelivery: sel ? arr.filter(x => x !== s) : [...arr, s] });
                            }} className="cursor-pointer" style={{
                              padding: '3px 8px', fontSize: 11, borderRadius: 999,
                              border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                              color: sel ? '#0F0F10' : '#6B7280',
                              background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{s}</button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <Input label="STORAGE LOCATION" value={form.storageLocation || ''} onChange={e => setForm({ ...form, storageLocation: e.target.value })} />
                  <Input label="SUPPLIER" value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} />
                  <Input label="PURCHASE SOURCE" placeholder="Souq, Private seller, Auction..." value={form.purchaseSource || ''} onChange={e => setForm({ ...form, purchaseSource: e.target.value })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>PAID FROM</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
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
                  <Input label="PURCHASE DATE" type="date" value={form.purchaseDate || ''} onChange={e => setForm({ ...form, purchaseDate: e.target.value })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                    <textarea
                      value={form.notes || ''}
                      onChange={e => setForm({ ...form, notes: e.target.value })}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {product.scopeOfDelivery.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>Scope of Delivery</span>
                      <div className="flex flex-wrap gap-2">
                        {product.scopeOfDelivery.map(item => (
                          <span key={item} style={{ padding: '4px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #D5D9DE', color: '#4B5563' }}>{item}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {renderField('Quantity', `${product.quantity || 1} ${(product.quantity || 1) === 1 ? 'piece' : 'pieces'}`)}
                  {renderField('Condition', product.condition)}
                  {renderField('Storage', product.storageLocation)}
                  {renderField('Source', product.sourceType === 'OWN' ? 'Own' : product.sourceType === 'CONSIGNMENT' ? 'Consignment' : 'Agent')}
                  {renderField('Supplier', product.supplierName)}
                  {renderField('Purchase Source', product.purchaseSource)}
                  {renderField('Paid From', product.paidFrom ? (product.paidFrom === 'cash' ? 'Cash' : 'Bank') : undefined)}
                  {renderField('Purchase Date', product.purchaseDate)}
                  {renderField('Days in Stock', product.daysInStock !== undefined ? `${product.daysInStock} days` : undefined)}
                  {product.notes && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{product.notes}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {editing && perm.canDeleteProducts && (
              <div className="flex gap-2" style={{ marginTop: 20 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Item
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Item" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete <strong style={{ color: '#0F0F10' }}>{product.brand} {product.name}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="products"
        entityId={product.id}
        title={`History · ${product.brand} ${product.name}`}
      />
    </div>
  );
}
