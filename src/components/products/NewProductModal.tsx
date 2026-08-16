// Plan §Code-Hygiene: gemeinsame New-Product-Erfassung für Collection,
// Purchase und (perspektivisch) Consignment. Aktuell genutzt in PurchaseCreate.
// WatchList + ConsignmentList haben noch eigene Inline-Markups, weil sie
// jeweils tiefer integriert sind (Errors-Map, Layout-Verschachtelung) — können
// später migriert werden.
//
// Layout: Kategorie-Chips → Brand/Name/SKU → dyn. Attribute → Condition →
// Scope → AI Identify → Photos → Tax-Scheme + Storage → Notes → Save/Cancel.
import { applyChoiceSelection } from '@/core/products/choice-value';
import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkuInput } from '@/components/ui/SkuInput';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { DuplicateWarningModal, type DuplicateMatch } from '@/components/ui/DuplicateWarningModal';
import { useProductStore } from '@/stores/productStore';
import type { Product, Category } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';
import { validateProductFields, blockingIssues, stripStaleAttributes, visibleAttributes, isBrandRequired } from '@/core/products/field-contract';

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
  const { products, categories, loadCategories, isSkuTaken, findPossibleDuplicates } = useProductStore();
  const [form, setForm] = useState<Partial<Product>>({});
  const [selectedCat, setSelectedCat] = useState<Category | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [skuError, setSkuError] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);
  const lastCheckedFp = useRef('');
  const lastDismissedFp = useRef('');
  // MEDIA-04A-3B2C3-R1: AI stale/supersession guard.
  const aiReqRef = useRef(0);
  const aiMountedRef = useRef(true);
  useEffect(() => { aiMountedRef.current = true; return () => { aiMountedRef.current = false; }; }, []);
  const aiImgRef = useRef<string | undefined>(undefined);
  aiImgRef.current = form.images?.[0];

  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Live Duplicate Detection — siehe WatchList für die Mechanik.
  const attrs = form.attributes || {};
  const fp = [
    form.brand, form.name, form.sku,
    attrs.reference_number, attrs.serial_number,
    attrs.weight, attrs.karat, attrs.item_type,
  ].map(v => String(v ?? '').trim().toUpperCase()).join('|');
  useEffect(() => {
    if (!open) { lastCheckedFp.current = ''; lastDismissedFp.current = ''; return; }
    if (duplicateMatches.length > 0) return;
    if (!form.brand?.trim() && !form.name?.trim() && !form.sku?.trim()) return;
    if (fp === lastCheckedFp.current) return;
    if (fp === lastDismissedFp.current) return;
    const t = setTimeout(() => {
      lastCheckedFp.current = fp;
      const possible = findPossibleDuplicates(form);
      if (possible.length > 0) setDuplicateMatches(possible);
    }, 800);
    return () => clearTimeout(t);
  }, [fp, open, duplicateMatches.length, form, findPossibleDuplicates]);

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

  // CLEARABLE CHOICES — a click on the ALREADY selected option removes the value entirely (the key is
  // deleted, not blanked). Same helper in create, quick-add and edit, so the three cannot drift.
  function toggleAttr(key: string, value: string | number | boolean) {
    setForm(p => ({ ...p, attributes: applyChoiceSelection(p.attributes as Record<string, unknown>, key, value) as typeof p.attributes }));
  }

  function validateForm(): string[] {
    // DESKTOP-CONTRACT: one shared validation for create, edit and the mobile v2 gate
    // (`core/products/field-contract`) — requiredness comes from the category SSOT and is
    // computed dependsOn-aware, so a hidden attribute is never demanded here either.
    // Condition stays optional (2026-05-17); pricing has no rule on any surface.
    return blockingIssues(validateProductFields(selectedCat, {
      categoryId: form.categoryId, brand: form.brand, name: form.name, attributes: form.attributes,
    })).map(i => i.label);
  }

  function handleSubmit() {
    // Strikte Validierung: alle Pflichtfelder müssen ausgefüllt sein.
    if (!form.categoryId) return;
    const missing = validateForm();
    if (missing.length > 0) {
      alert(`Please fill in the required fields:\n• ${missing.join('\n• ')}`);
      return;
    }
    if (form.sku && isSkuTaken(form.sku)) { setSkuError(true); return; }
    setSkuError(false);
    // Score-basierte Duplicate Detection (nicht-blockierend).
    const possible = findPossibleDuplicates(form);
    if (possible.length > 0) {
      setDuplicateMatches(possible);
      return;
    }
    onSubmit(submitPayload());
  }

  /** DESKTOP-CONTRACT: never hand out an attribute whose dependsOn is unsatisfied — the
   *  same strip the edit path and the mobile v2 gate apply, so no stale value is created. */
  function submitPayload(): Partial<Product> {
    return { ...form, attributes: stripStaleAttributes(selectedCat, form.attributes) as Product['attributes'] };
  }

  function confirmCreateAnyway() {
    setDuplicateMatches([]);
    onSubmit(submitPayload());
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

        {/* Brand + Name. v0.6.8 — bei unbranded Gold-Schmuck (selbst geschmiedet)
            sind Brand/Name optional; bei Watch/Branded usw. weiter Pflicht. */}
        {(() => {
          // v0.7.16 — unbranded Kategorien (Brand+Name optional): cat-gold-jewelry
    // (handgemachtes Diamant-Schmuck) + cat-accessory (gemischtes Sortiment
    // mit vielen no-name Stuecken). Rest = branded (Watch, Original Gold,
    // Branded Gold, Spare Part) -> Brand+Name Pflicht.
    const brandedRequired = isBrandRequired(selectedCat?.id || '');
          return (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Input required={brandedRequired} label={brandedRequired ? 'BRAND' : 'BRAND (OPTIONAL)'}
                placeholder={brandedRequired ? 'e.g. Rolex, Hermes, Cartier' : 'leer = unbranded'}
                value={form.brand || ''}
                onChange={e => setForm(p => ({ ...p, brand: e.target.value }))} />
              <Input required={brandedRequired} label={brandedRequired ? 'NAME / MODEL' : 'NAME / MODEL (OPTIONAL)'}
                placeholder={brandedRequired ? 'e.g. Submariner, Birkin 30' : 'leer = Beleg nimmt Beschreibung'}
                value={form.name || ''}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            </div>
          );
        })()}

        {/* SKU + (optional) Quantity */}
        <div style={{ display: 'grid', gridTemplateColumns: hideFields?.quantity ? '1fr' : '2fr 1fr', gap: 16 }}>
          <SkuInput value={form.sku || ''} onChange={v => { setForm(p => ({ ...p, sku: v })); if (skuError) setSkuError(false); }} />
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
              {/* DESKTOP-CONTRACT: visibility comes from the shared contract (dependsOn-aware),
                  identical to ProductDetail and the mobile form — no second copy of the rule. */}
              {visibleAttributes(selectedCat, form.attributes).map(attr => {
                const isWide = attr.type === 'select' && (attr.options?.length || 0) >= 8;
                if (attr.type === 'select' && attr.options) {
                  return (
                    <div key={attr.key} style={{ gridColumn: isWide ? '1 / -1' : 'auto' }}>
                      <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                        {attr.label.toUpperCase()}
                        {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                      </span>
                      <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                        {attr.options.map(opt => (
                          <button key={opt} onClick={() => toggleAttr(attr.key, opt)}
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
                // v0.7.14 — Boolean → Yes/No-Toggle. Vorher fiel boolean durch
                // zum Text-Input → User tippte "true"/"false". Spiegelung des
                // Patterns aus OrderDetail.
                if (attr.type === 'boolean') {
                  const val = form.attributes?.[attr.key];
                  return (
                    <div key={attr.key}>
                      <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                        {attr.label.toUpperCase()}
                        {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                      </span>
                      <div className="flex gap-2" style={{ marginTop: 6 }}>
                        {[true, false].map(opt => (
                          <button key={String(opt)} type="button" onClick={() => toggleAttr(attr.key, opt)}
                            className="cursor-pointer rounded"
                            style={{
                              padding: '4px 14px', fontSize: 11, borderRadius: 999,
                              border: `1px solid ${val === opt ? '#0F0F10' : '#D5D9DE'}`,
                              color: val === opt ? '#0F0F10' : '#6B7280',
                              background: val === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{opt ? 'Yes' : 'No'}</button>
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
              CONDITION
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
                  Auto-fills brand, name, category fields and description — everything stays editable.
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
                    // AI-Learning: User-Korrekturen aus aehnlichen Items als
                    // Few-Shot mitsenden (siehe getRecentCorrectionsAsPrompt).
                    const myReq = ++aiReqRef.current;
                    const frozenImg = form.images?.[0];
                    const { getRecentCorrectionsAsPrompt } = await import('@/stores/productStore');
                    const { shouldApplyEphemeralResult } = await import('@/core/media/ai-image-source');
                    const { identifyProductFromResolvedInput } = await import('@/core/ai/identify-adapter');
                    // MEDIA-04A-3B2C3-R3: route through the SINGLE central adapter
                    // (safe fresh data: URL only; never a blob:/object URL) — no
                    // direct provider call.
                    const aiOut = await identifyProductFromResolvedInput({
                      productId: undefined,
                      formImage0: hasImage ? form.images![0] : undefined,
                      categoryId: form.categoryId as AiCategoryId,
                      hints: hasHints ? { brand: form.brand, name: form.name, reference: form.sku } : undefined,
                      recentCorrections: getRecentCorrectionsAsPrompt(form.brand, form.categoryId),
                    });
                    if (!aiOut.ok) { if (aiOut.blocking) alert(`AI: ${aiOut.error}`); setAiBusy(false); return; }
                    const result = aiOut.result;
                    // Stale/supersession guard: drop the result if a newer request
                    // superseded it, the modal unmounted, or the picked image changed.
                    if (!shouldApplyEphemeralResult({ myRequestId: myReq, latestRequestId: aiReqRef.current, unmounted: !aiMountedRef.current, frozenImage: frozenImg, currentImage: aiImgRef.current })) { setAiBusy(false); return; }
                    setForm(f => {
                      const updated = { ...f };
                      if (result.brand) updated.brand = result.brand;
                      if (result.name) updated.name = result.name;
                      // SKU-UNIFY — the AI does NOT decide a SKU. This form feeds purchase / order /
                      // production creates, which persist exactly what was typed; leaving the field
                      // alone keeps a suggested number from being written as if it had been claimed.
                      if (result.condition) updated.condition = result.condition;
                      if (result.description) updated.notes = f.notes ? `${f.notes}\n\n${result.description}` : result.description;
                      // AI-PRICE — the model does not price the stock; see `edit-merge`.
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
                      // AI-Learning: Snapshot speichern damit Editing-Korrekturen
                      // spaeter erkannt werden (Diff in ProductDetail-Save).
                      updated.aiIdentifiedSnapshot = JSON.stringify({
                        brand: result.brand,
                        name: result.name,
                        sku: result.sku,
                        condition: result.condition,
                        attributes: result.attributes,
                        identificationConfidence: result.identificationConfidence,
                        at: new Date().toISOString(),
                      });
                      return updated;
                    });
                    // Sofortige Duplicate-Detection direkt nach AI-Erkennung —
                    // siehe WatchList für Begründung. Kandidat aus result bauen,
                    // da setForm async ist.
                    const candidate: Partial<Product> = {
                      categoryId: form.categoryId,
                      brand: result.brand || form.brand,
                      name: result.name || form.name,
                      sku: form.sku || undefined,
                      attributes: { ...(form.attributes || {}), ...(result.attributes || {}) } as Product['attributes'],
                      images: form.images,
                    };
                    const possible = findPossibleDuplicates(candidate);
                    if (possible.length > 0) setDuplicateMatches(possible);
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

        {/* v0.6.8 — TAX SCHEME entfernt: VAT wird beim Verkauf (Invoice/Convert)
            gewaehlt, nicht beim Produkt-Anlegen. taxScheme bleibt im DB-Modell
            mit Default 'MARGIN' (siehe useEffect-Init), kann spaeter ueber den
            ConfirmTaxSchemeModal beim Convert pro Zeile gesetzt werden. */}
        {!hideFields?.storageLocation && (
          <Input label="STORAGE LOCATION" placeholder="Safe, Shelf, Display..."
            value={form.storageLocation || ''}
            onChange={e => setForm(p => ({ ...p, storageLocation: e.target.value }))} />
        )}

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
            disabled={!form.categoryId}
          >
            <Save size={14} /> {submitLabel || 'Save'}
          </Button>
        </div>
      </div>

      <DuplicateWarningModal
        open={duplicateMatches.length > 0}
        matches={duplicateMatches}
        candidate={form}
        onCancel={() => { lastDismissedFp.current = fp; setDuplicateMatches([]); }}
        onCreateAnyway={confirmCreateAnyway}
        onCopyDetails={(id) => {
          const src = products.find(p => p.id === id);
          if (!src) return;
          const srcAttrs = { ...(src.attributes || {}) } as Record<string, unknown>;
          delete srcAttrs.serial_number; delete srcAttrs.serialNo;
          setForm(f => ({
            ...f,
            brand: src.brand,
            name: src.name,
            categoryId: src.categoryId,
            condition: src.condition,
            taxScheme: src.taxScheme,
            plannedSalePrice: src.plannedSalePrice,
            minSalePrice: src.minSalePrice,
            maxSalePrice: src.maxSalePrice,
            storageLocation: src.storageLocation,
            scopeOfDelivery: [...(src.scopeOfDelivery || [])],
            notes: src.notes,
            images: (f.images && f.images.length > 0) ? f.images : [...(src.images || [])],
            attributes: { ...(f.attributes || {}), ...srcAttrs } as typeof f.attributes,
          }));
          setSelectedCat(categories.find(c => c.id === src.categoryId) || null);
          lastDismissedFp.current = fp;
          setDuplicateMatches([]);
        }}
      />
    </Modal>
  );
}
