// Plan §Code-Hygiene: gemeinsame New-Product-Erfassung für Collection,
// Purchase und (perspektivisch) Consignment. Aktuell genutzt in PurchaseCreate.
// WatchList + ConsignmentList haben noch eigene Inline-Markups, weil sie
// jeweils tiefer integriert sind (Errors-Map, Layout-Verschachtelung) — können
// später migriert werden.
//
// Layout: Kategorie-Chips → Brand/Name/SKU → dyn. Attribute → Condition →
// Scope → AI Identify → Photos → Tax-Scheme + Storage → Notes → Save/Cancel.
import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { useProductStore } from '@/stores/productStore';
import type { Product, Category, TaxScheme } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';

export interface NewProductModalProps {
  open: boolean;
  onClose: () => void;
  /** Wird mit dem fertigen Product-Spec aufgerufen — Caller entscheidet, wie/wo gespeichert wird. */
  onSubmit: (product: Partial<Product>) => void;
  /** Vorbelegung beim Öffnen (z.B. Edit eines bestehenden Drafts). */
  initial?: Partial<Product>;
  title?: string;
  submitLabel?: string;
  /** Optionaler Hinweistext oben im Modal. */
  hint?: React.ReactNode;
  /** Welche Felder ausgeblendet werden sollen (kontextspezifisch). */
  hideFields?: {
    purchasePrice?: boolean;
    salePrice?: boolean;
    paidFrom?: boolean;
    supplier?: boolean;
    quantity?: boolean;
    storageLocation?: boolean;
  };
}

export function NewProductModal({
  open, onClose, onSubmit, initial, title, submitLabel, hint, hideFields,
}: NewProductModalProps) {
  const { categories, loadCategories, nextAvailableSku } = useProductStore();
  const [form, setForm] = useState<Partial<Product>>({});
  const [selectedCat, setSelectedCat] = useState<Category | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Reset form when opening (or when initial changes)
  useEffect(() => {
    if (!open) return;
    const init: Partial<Product> = initial ?? {
      condition: '', taxScheme: 'MARGIN', scopeOfDelivery: [],
      purchaseCurrency: 'BHD', attributes: {}, images: [],
    };
    setForm(init);
    const cat = categories.find(c => c.id === init.categoryId) || null;
    setSelectedCat(cat);
  }, [open, initial, categories]);

  const visibleCategories = categories.filter(c => !c.id.startsWith('cat-repair-service'));

  function updateAttr(key: string, value: string | number | boolean) {
    setForm(p => ({ ...p, attributes: { ...(p.attributes || {}), [key]: value } }));
  }

  function handleSubmit() {
    if (!form.categoryId || !form.brand || !form.name) return;
    onSubmit(form);
  }

  return (
    <Modal open={open} onClose={onClose} title={title || 'New Item'} width={680}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        {hint && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, background: '#F2F7FA',
            border: '1px solid #E5E9EE', color: '#6B7280', fontSize: 12, lineHeight: 1.5,
          }}>{hint}</div>
        )}

        {/* Kategorie */}
        <div>
          <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
            CATEGORY <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
          </span>
          <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
            {visibleCategories.map(cat => (
              <button key={cat.id}
                onClick={() => {
                  setSelectedCat(cat);
                  setForm(f => ({ ...f, categoryId: cat.id, condition: cat.conditionOptions?.[0] || '', attributes: {} }));
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

        {/* Brand + Name */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input required label="BRAND" placeholder="e.g. Rolex, Hermes, Cartier"
            value={form.brand || ''}
            onChange={e => setForm(p => ({ ...p, brand: e.target.value }))} />
          <Input required label="NAME / MODEL" placeholder="e.g. Submariner, Birkin 30"
            value={form.name || ''}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
        </div>

        {/* SKU + (optional) Quantity */}
        <div style={{ display: 'grid', gridTemplateColumns: hideFields?.quantity ? '1fr' : '2fr 1fr', gap: 16 }}>
          <Input label="SKU / REFERENCE" placeholder="Internal reference"
            value={form.sku || ''}
            onChange={e => setForm(p => ({ ...p, sku: e.target.value }))} />
          {!hideFields?.quantity && (
            <Input label="QUANTITY" type="number" placeholder="1"
              value={form.quantity || 1}
              onChange={e => setForm(p => ({ ...p, quantity: Math.max(1, Number(e.target.value) || 1) }))} />
          )}
        </div>

        {/* Dynamische Kategorie-Attribute */}
        {selectedCat && selectedCat.attributes.length > 0 && (
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
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
                  <div key={attr.key}>
                    <Input
                      required={attr.required}
                      label={attr.label.toUpperCase() + (attr.unit ? ` (${attr.unit})` : '')}
                      type={attr.type === 'number' ? 'number' : 'text'}
                      placeholder={attr.label}
                      value={(form.attributes?.[attr.key] as string) || ''}
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
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
              CONDITION <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
            </span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {selectedCat.conditionOptions.map(cond => (
                <button key={cond} onClick={() => setForm(p => ({ ...p, condition: cond }))}
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

        {/* Scope / Included */}
        {selectedCat && selectedCat.scopeOptions.length > 0 && (
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>INCLUDED</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {selectedCat.scopeOptions.map(item => {
                const sel = (form.scopeOfDelivery || []).includes(item);
                return (
                  <button key={item}
                    onClick={() => setForm(p => {
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
        {form.categoryId && (
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
              <div>
                <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                  Füllt Brand, Name, Kategorie-Felder und Description automatisch — alles bleibt editierbar.
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
        <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
            <span className="text-overline">PHOTOS</span>
            <span style={{ fontSize: 11, color: '#6B7280' }}>Add at least one photo for best AI results</span>
          </div>
          <ImageUpload images={form.images || []}
            onChange={imgs => setForm(p => ({ ...p, images: imgs }))}
            maxImages={6} />
        </div>

        {/* Tax Scheme + (optional) Storage Location */}
        <div style={{ display: 'grid', gridTemplateColumns: hideFields?.storageLocation ? '1fr' : '1fr 1fr', gap: 16 }}>
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>TAX SCHEME (WHEN SOLD)</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(scheme => (
                <button key={scheme} onClick={() => setForm(p => ({ ...p, taxScheme: scheme }))}
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
          {!hideFields?.storageLocation && (
            <Input label="STORAGE LOCATION" placeholder="Safe, Shelf, Display..."
              value={form.storageLocation || ''}
              onChange={e => setForm(p => ({ ...p, storageLocation: e.target.value }))} />
          )}
        </div>

        {/* Optional Pricing fields (controlled by hideFields) */}
        {(!hideFields?.purchasePrice || !hideFields?.salePrice) && (
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
            <span className="text-overline" style={{ marginBottom: 12 }}>PRICING (OPTIONAL)</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              {!hideFields?.purchasePrice && (
                <Input label="PURCHASE PRICE (BHD)" type="number" placeholder="0"
                  value={form.purchasePrice || ''}
                  onChange={e => setForm(p => ({ ...p, purchasePrice: Number(e.target.value) || 0 }))} />
              )}
              {!hideFields?.salePrice && (
                <Input label="SALE PRICE (BHD)" type="number" placeholder="Listing / target price"
                  value={form.plannedSalePrice || ''}
                  onChange={e => setForm(p => ({ ...p, plannedSalePrice: Number(e.target.value) || undefined }))} />
              )}
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
          <textarea value={form.notes || ''}
            onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
            rows={3} placeholder="Optional internal notes…"
            style={{ width: '100%', padding: '10px 12px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, resize: 'vertical' }} />
        </div>

        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit}
            disabled={!form.categoryId || !form.brand || !form.name}
          >
            <Save size={14} /> {submitLabel || 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
