// Plan §Purchases — Full-Page New Purchase (wie Invoice/Order).
// Sections: Supplier / Items / Pricing / Initial Payment / Notes / Summary / Actions.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, X, Edit3 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { Modal } from '@/components/ui/Modal';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useProductStore } from '@/stores/productStore';
import type { Product, Category, TaxScheme } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface DraftLine {
  mode: 'existing' | 'new';
  productId?: string;
  // Plan §Purchase §New-Item: für Source='new' wird die Ware mit voller
  // Collection-Spec über Modal erfasst (Kategorie + dyn. Attribute + Photos
  // + Tax-Scheme + Storage). Wir spiegeln Brand/Name/SKU/categoryId hier
  // für die Inline-Anzeige in der Tabelle, das tatsächliche Produkt-Spec
  // lebt in `newProduct`.
  newProduct?: Partial<Product>;
  brand: string;
  name: string;
  sku: string;
  categoryId: string;
  quantity: number;
  unitPrice: number;
}

export function PurchaseCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { createPurchase } = usePurchaseStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { products, loadProducts, categories, loadCategories, nextAvailableSku } = useProductStore();

  useEffect(() => { loadSuppliers(); loadProducts(); loadCategories(); }, [loadSuppliers, loadProducts, loadCategories]);

  const [supplierId, setSupplierId] = useState(searchParams.get('supplier') || '');
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0]);
  const [lines, setLines] = useState<DraftLine[]>([
    { mode: 'new', brand: '', name: '', sku: '', categoryId: categories[0]?.id || '', quantity: 1, unitPrice: 0 },
  ]);
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank'>('bank');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  // Plan §Purchase §Tax: Vorsteuer-Scheme für die ganze Purchase. Default ZERO
  // (Backward-Compat); bei VAT_10 wird vat_amount per Line dekomponiert.
  const [purchaseTaxScheme, setPurchaseTaxScheme] = useState<'ZERO' | 'VAT_10'>('ZERO');

  // Plan §Purchase §New-Item: Modal für volle Item-Erfassung (wie Collection > New Item)
  const [newItemModalIdx, setNewItemModalIdx] = useState<number | null>(null);
  const [modalProduct, setModalProduct] = useState<Partial<Product>>({});
  const [modalSelectedCat, setModalSelectedCat] = useState<Category | null>(null);
  const [modalAiBusy, setModalAiBusy] = useState(false);

  const supplier = useMemo(() => suppliers.find(s => s.id === supplierId), [suppliers, supplierId]);
  const supplierOptions = useMemo(() => suppliers.map(s => ({
    id: s.id,
    label: s.name,
    subtitle: s.phone || s.email,
  })), [suppliers]);
  const productOptions = useMemo(() => products.map(p => ({
    id: p.id,
    label: `${p.brand} ${p.name}`,
    subtitle: p.sku || undefined,
    meta: `${fmt(p.purchasePrice || 0)} BHD`,
  })), [products]);

  // unit_price ist gross-incl-VAT (was an Lieferanten gezahlt wird).
  // total bleibt gross; net + vat-out werden für Anzeige + Reports dekomponiert.
  const total = lines.reduce((s, l) => s + (l.quantity || 0) * (l.unitPrice || 0), 0);
  const inputVatRate = purchaseTaxScheme === 'VAT_10' ? 10 : 0;
  const inputVat = inputVatRate > 0 ? total * inputVatRate / (100 + inputVatRate) : 0;
  const subtotal = total - inputVat; // = NET (nach Vorsteuer-Abzug)
  const remaining = Math.max(0, total - paymentAmount);
  const status: 'DRAFT' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' =
    total <= 0 ? 'DRAFT'
    : paymentAmount <= 0 ? 'UNPAID'
    : paymentAmount >= total - 0.001 ? 'PAID'
    : 'PARTIALLY_PAID';

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  function addLine() {
    setLines(prev => [...prev, { mode: 'new', brand: '', name: '', sku: '', categoryId: categories[0]?.id || '', quantity: 1, unitPrice: 0 }]);
  }

  function removeLine(idx: number) {
    setLines(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));
  }

  function pickProductForLine(idx: number, productId: string) {
    const p = products.find(pp => pp.id === productId);
    if (!p) return;
    updateLine(idx, {
      productId,
      newProduct: undefined,
      brand: p.brand,
      name: p.name,
      sku: p.sku || '',
      categoryId: p.categoryId,
      unitPrice: p.purchasePrice || 0,
    });
  }

  function openNewItemModal(idx: number) {
    const line = lines[idx];
    const prefill: Partial<Product> = line?.newProduct ?? {
      categoryId: line?.categoryId || categories[0]?.id || '',
      brand: line?.brand || '',
      name: line?.name || '',
      sku: line?.sku || '',
      condition: '',
      taxScheme: 'MARGIN',
      scopeOfDelivery: [],
      purchaseCurrency: 'BHD',
      attributes: {},
      images: [],
    };
    setModalProduct(prefill);
    setModalSelectedCat(categories.find(c => c.id === prefill.categoryId) || categories[0] || null);
    setNewItemModalIdx(idx);
  }

  function updateModalAttr(key: string, value: string | number | boolean) {
    setModalProduct(p => ({ ...p, attributes: { ...(p.attributes || {}), [key]: value } }));
  }

  function handleModalSave() {
    if (newItemModalIdx == null) return;
    if (!modalProduct.categoryId || !modalProduct.brand || !modalProduct.name) return;
    updateLine(newItemModalIdx, {
      newProduct: modalProduct,
      brand: modalProduct.brand || '',
      name: modalProduct.name || '',
      sku: modalProduct.sku || '',
      categoryId: modalProduct.categoryId || '',
    });
    setNewItemModalIdx(null);
  }

  function reset() {
    setSupplierId('');
    setPurchaseDate(new Date().toISOString().split('T')[0]);
    setLines([{ mode: 'new', brand: '', name: '', sku: '', categoryId: categories[0]?.id || '', quantity: 1, unitPrice: 0 }]);
    setPaymentAmount(0);
    setPaymentMethod('bank');
    setNotes('');
    setError('');
  }

  function validate(): string | null {
    if (!supplierId) return 'Please select a supplier';
    if (lines.length === 0) return 'Please add at least one line';
    const bad = lines.findIndex(l =>
      l.quantity <= 0 || l.unitPrice < 0 ||
      (l.mode === 'new' ? (!l.brand || !l.name) : !l.productId)
    );
    if (bad !== -1) return `Line ${bad + 1}: Brand+Name (oder Product) + Qty > 0 + Price ≥ 0 erforderlich`;
    if (paymentAmount < 0) return 'Payment cannot be negative';
    if (paymentAmount > total) return `Payment (${fmt(paymentAmount)}) exceeds total (${fmt(total)})`;
    return null;
  }

  function handleSave(continueEditing: boolean) {
    setError('');
    const v = validate();
    if (v) { setError(v); return; }

    const payload = lines.map(l => l.mode === 'existing'
      ? { productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, taxScheme: purchaseTaxScheme, vatRate: inputVatRate }
      : {
          // Plan §Purchase §New-Item: Wenn Modal-Spec da ist, volle Product-Specs durchreichen.
          // Sonst Legacy-Inline-Pfad mit nur Brand/Name/SKU/Kategorie.
          newProduct: l.newProduct,
          newProductBrand: l.brand,
          newProductName: l.name,
          newProductSku: l.sku || undefined,
          newProductCategoryId: l.categoryId || undefined,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxScheme: purchaseTaxScheme,
          vatRate: inputVatRate,
        });

    const purchase = createPurchase({
      supplierId,
      purchaseDate,
      notes: notes || undefined,
      lines: payload,
      initialPayment: paymentAmount > 0 ? { amount: paymentAmount, method: paymentMethod } : undefined,
    });

    if (continueEditing) {
      reset();
    } else {
      navigate(`/purchases/${purchase.id}`);
    }
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 80px', maxWidth: 1100 }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <div>
            <button onClick={() => navigate('/purchases')}
              className="flex items-center gap-2 cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13, marginBottom: 8 }}>
              <ArrowLeft size={16} /> Purchases
            </button>
            <h1 className="font-display" style={{ fontSize: 30, color: '#0F0F10', lineHeight: 1.2 }}>New Purchase</h1>
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Supplier, items, payment — all on one page.</p>
          </div>
          <span style={{
            padding: '6px 14px', borderRadius: 999, fontSize: 11, letterSpacing: '0.06em',
            background: status === 'PAID' ? 'rgba(126,170,110,0.12)' : status === 'PARTIALLY_PAID' ? 'rgba(170,149,110,0.12)' : 'rgba(220,38,38,0.08)',
            color: status === 'PAID' ? '#5C8550' : status === 'PARTIALLY_PAID' ? '#7A6B4F' : '#AA6E6E',
            border: `1px solid ${status === 'PAID' ? 'rgba(126,170,110,0.4)' : status === 'PARTIALLY_PAID' ? 'rgba(170,149,110,0.4)' : 'rgba(220,38,38,0.3)'}`,
          }}>
            {status}
          </span>
        </div>

        {/* 1. SUPPLIER */}
        <Card>
          <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>1 · SUPPLIER</span>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginTop: 12 }}>
            <SearchSelect
              label="SUPPLIER"
              placeholder="Search suppliers..."
              options={supplierOptions}
              value={supplierId}
              onChange={setSupplierId}
            />
            <Input required label="PURCHASE DATE" type="date"
              value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} />
          </div>
          {supplier && (
            <div style={{ padding: '10px 14px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8, marginTop: 12, fontSize: 12, color: '#4B5563' }}>
              {supplier.name}{supplier.phone ? ` · ${supplier.phone}` : ''}{supplier.email ? ` · ${supplier.email}` : ''}
            </div>
          )}
        </Card>

        {/* 2. ITEMS */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span className="text-overline">2 · ITEMS</span>
              <Button variant="secondary" onClick={addLine}><Plus size={12} /> Add Item</Button>
            </div>
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 8 }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '110px minmax(0,2.2fr) minmax(0,0.9fr) 60px minmax(0,1fr) minmax(0,1fr) 44px',
                gap: 10, padding: '10px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE',
                fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span>Source</span>
                <span>Product</span>
                <span>SKU</span>
                <span>Qty</span>
                <span>Unit Price (BHD)</span>
                <span style={{ textAlign: 'right' }}>Line Total</span>
                <span></span>
              </div>
              {lines.map((l, idx) => (
                <div key={idx} style={{
                  display: 'grid',
                  gridTemplateColumns: '110px minmax(0,2.2fr) minmax(0,0.9fr) 60px minmax(0,1fr) minmax(0,1fr) 44px',
                  gap: 10, padding: '10px 12px', borderBottom: '1px solid #E5E9EE', alignItems: 'center',
                }}>
                  {/* Source toggle — bei „New Item" öffnet sich automatisch das Modal */}
                  <select value={l.mode}
                    onChange={e => {
                      const newMode = e.target.value as 'existing' | 'new';
                      updateLine(idx, { mode: newMode, productId: undefined });
                      if (newMode === 'new') openNewItemModal(idx);
                    }}
                    style={{ padding: '7px 8px', fontSize: 11, border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF', minWidth: 0, width: '100%' }}>
                    <option value="new">New Item</option>
                    <option value="existing">Existing</option>
                  </select>

                  {/* Product picker (existing) oder Item-Card mit Edit-Button (new) */}
                  {l.mode === 'existing' ? (
                    <div style={{ minWidth: 0 }}>
                      <SearchSelect
                        placeholder="Pick product..."
                        options={productOptions}
                        value={l.productId || ''}
                        onChange={pid => pickProductForLine(idx, pid)}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                      {l.brand || l.name ? (
                        <div className="flex items-center justify-between" style={{
                          flex: 1, minWidth: 0, padding: '7px 10px',
                          background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 4,
                          fontSize: 12, color: '#0F0F10',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {l.brand} <span style={{ color: '#4B5563' }}>{l.name}</span>
                          </span>
                          <button onClick={() => openNewItemModal(idx)} title="Edit item details"
                            className="cursor-pointer flex items-center gap-1"
                            style={{ background: 'none', border: 'none', color: '#6B7280', padding: '0 0 0 8px', fontSize: 11 }}>
                            <Edit3 size={12} /> Edit
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => openNewItemModal(idx)}
                          className="cursor-pointer"
                          style={{
                            flex: 1, padding: '7px 10px', fontSize: 12,
                            border: '1px dashed #D5D9DE', borderRadius: 4,
                            background: '#FFFFFF', color: '#6B7280',
                            textAlign: 'left', minWidth: 0,
                          }}>
                          + Define new item…
                        </button>
                      )}
                    </div>
                  )}

                  <input placeholder="SKU" value={l.sku}
                    onChange={e => updateLine(idx, { sku: e.target.value })}
                    disabled={l.mode === 'existing'}
                    className="font-mono"
                    style={{ padding: '7px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4,
                      opacity: l.mode === 'existing' ? 0.5 : 1, minWidth: 0, width: '100%' }} />

                  <input type="number" min={1} step="1" value={l.quantity}
                    onChange={e => updateLine(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                    className="font-mono"
                    style={{ padding: '8px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 4, textAlign: 'right', minWidth: 0, width: '100%' }} />
                  <input type="number" min={0} step="0.001" value={l.unitPrice}
                    onChange={e => updateLine(idx, { unitPrice: parseFloat(e.target.value) || 0 })}
                    className="font-mono"
                    style={{ padding: '8px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 4, textAlign: 'right', minWidth: 0, width: '100%' }} />
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fmt((l.quantity || 0) * (l.unitPrice || 0))}
                  </span>
                  <button onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    title={lines.length === 1 ? 'Mindestens eine Zeile erforderlich' : 'Diese Zeile entfernen'}
                    className="cursor-pointer transition-all"
                    style={{
                      width: 36, height: 36, borderRadius: 10,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: lines.length === 1 ? 'rgba(220,38,38,0.05)' : 'rgba(220,38,38,0.10)',
                      border: '1px solid ' + (lines.length === 1 ? 'rgba(220,38,38,0.15)' : 'rgba(220,38,38,0.30)'),
                      color: '#DC2626',
                      opacity: lines.length === 1 ? 0.4 : 1,
                      cursor: lines.length === 1 ? 'not-allowed' : 'pointer',
                    }}
                    onMouseEnter={e => { if (lines.length > 1) { e.currentTarget.style.background = '#DC2626'; e.currentTarget.style.color = '#FFFFFF'; } }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(220,38,38,0.10)'; e.currentTarget.style.color = '#DC2626'; }}>
                    <Trash2 size={16} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
              „New Item&quot; öffnet ein Pop-up zum vollen Erfassen (Kategorie, Attribute, Photos, Tax-Scheme) — wie Collection &gt; New Item.
              „Existing&quot; bucht nur zusätzliche Menge auf ein bestehendes Produkt.
              Der Unit-Price ist gross-incl-VAT (was an den Lieferanten gezahlt wird).
            </p>
          </Card>
        </div>

        {/* 3. PRICING — inkl. Vorsteuer-Scheme (Plan §Purchase §Tax) */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3 · PRICING</span>
            <div style={{ marginBottom: 16 }}>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>INPUT VAT (VORSTEUER)</span>
              <div className="flex gap-2" style={{ marginTop: 6 }}>
                {(['ZERO', 'VAT_10'] as const).map(s => {
                  const active = purchaseTaxScheme === s;
                  return (
                    <button key={s} type="button" onClick={() => setPurchaseTaxScheme(s)}
                      className="cursor-pointer rounded"
                      style={{ padding: '8px 16px', fontSize: 13,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{s === 'ZERO' ? '0% (keine Vorsteuer)' : '10% (Vorsteuer enthalten)'}</button>
                  );
                })}
              </div>
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                Bei 10% wird die Vorsteuer aus dem Brutto-Total dekomponiert und in der Steuer-Abrechnung gegen die Output-VAT verrechnet.
              </p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NET</span>
                <div className="font-display" style={{ fontSize: 20, color: '#0F0F10' }}>
                  {fmt(subtotal)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>INPUT VAT</span>
                <div className="font-display" style={{ fontSize: 20, color: inputVat > 0 ? '#AA956E' : '#6B7280' }}>
                  {fmt(inputVat)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>TOTAL (PAID TO SUPPLIER)</span>
                <div className="font-display" style={{ fontSize: 24, color: '#C6A36D' }}>
                  {fmt(total)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* 4. INITIAL PAYMENT */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>4 · INITIAL PAYMENT (optional)</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <Input label="AMOUNT (BHD)" type="number" step="0.001"
                value={paymentAmount || ''} onChange={e => setPaymentAmount(parseFloat(e.target.value) || 0)} />
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
                <div className="flex gap-2" style={{ marginTop: 6 }}>
                  {(['cash', 'bank'] as const).map(m => {
                    const active = paymentMethod === m;
                    return (
                      <button key={m} type="button" onClick={() => setPaymentMethod(m)}
                        className="cursor-pointer rounded"
                        style={{ padding: '8px 16px', fontSize: 13,
                          border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                          color: active ? '#0F0F10' : '#6B7280',
                          background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="flex gap-2" style={{ marginTop: 14 }}>
              <button onClick={() => setPaymentAmount(total)}
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Full
              </button>
              <button onClick={() => setPaymentAmount(0)}
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Credit (later)
              </button>
            </div>
          </Card>
        </div>

        {/* Notes */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="z.B. Lieferscheinnummer, Zahlungsziel, interne Vermerke…"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, resize: 'vertical' }} />
          </Card>
        </div>

        {/* 5. SUMMARY */}
        <div style={{ marginTop: 24, padding: '20px 24px', background: 'linear-gradient(135deg, #1A1A1F 0%, #08080A 100%)', borderRadius: 12, border: '1px solid #2A2A30', color: '#FFFFFF' }}>
          <span style={{ fontSize: 11, color: '#8E8E97', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Summary</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>TOTAL</div>
              <div className="font-mono" style={{ fontSize: 18, color: '#FFFFFF' }}>{fmt(total)} BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>PAID</div>
              <div className="font-mono" style={{ fontSize: 18, color: '#7EAA6E' }}>{fmt(paymentAmount)} BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>REMAINING</div>
              <div className="font-mono" style={{ fontSize: 18, color: remaining > 0 ? '#AA956E' : '#7EAA6E' }}>{fmt(remaining)} BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>METHOD</div>
              <div style={{ fontSize: 18, color: '#FFFFFF', textTransform: 'capitalize' }}>{paymentMethod}</div>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, fontSize: 12, color: '#DC2626' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between" style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={() => navigate('/purchases')}><X size={14} /> Cancel</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => handleSave(true)}>Save &amp; New</Button>
            <Button variant="primary" onClick={() => handleSave(false)}><Save size={14} /> Save Purchase</Button>
          </div>
        </div>
      </div>

      {/* Plan §Purchase §New-Item: Volle Item-Erfassung wie Collection > New Item */}
      <Modal open={newItemModalIdx != null} onClose={() => setNewItemModalIdx(null)} title="New Item — Define Product" width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
          <div style={{
            padding: '8px 12px', borderRadius: 8, background: '#F2F7FA',
            border: '1px solid #E5E9EE', color: '#6B7280', fontSize: 12, lineHeight: 1.5,
          }}>
            <strong style={{ color: '#0F0F10' }}>Wird ins Lager aufgenommen.</strong> Einkaufspreis kommt aus der Purchase-Line — nicht doppelt eingeben.
          </div>

          {/* Kategorie */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
              CATEGORY <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
            </span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {categories.map(cat => (
                <button key={cat.id}
                  onClick={() => {
                    setModalSelectedCat(cat);
                    setModalProduct(p => ({ ...p, categoryId: cat.id, condition: cat.conditionOptions?.[0] || '', attributes: {} }));
                  }}
                  className="cursor-pointer rounded-lg transition-all duration-200"
                  style={{
                    padding: '10px 18px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${modalProduct.categoryId === cat.id ? cat.color : '#D5D9DE'}`,
                    color: modalProduct.categoryId === cat.id ? cat.color : '#6B7280',
                    background: modalProduct.categoryId === cat.id ? cat.color + '08' : 'transparent',
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
              value={modalProduct.brand || ''}
              onChange={e => setModalProduct(p => ({ ...p, brand: e.target.value }))} />
            <Input required label="NAME / MODEL" placeholder="e.g. Submariner, Birkin 30"
              value={modalProduct.name || ''}
              onChange={e => setModalProduct(p => ({ ...p, name: e.target.value }))} />
          </div>
          <Input label="SKU / REFERENCE" placeholder="Internal reference"
            value={modalProduct.sku || ''}
            onChange={e => setModalProduct(p => ({ ...p, sku: e.target.value }))} />

          {/* Dynamische Kategorie-Attribute */}
          {modalSelectedCat && modalSelectedCat.attributes.length > 0 && (
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
              <span className="text-overline" style={{ marginBottom: 12 }}>{modalSelectedCat.name.toUpperCase()} DETAILS</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
                {modalSelectedCat.attributes.map(attr => {
                  if (attr.type === 'select' && attr.options) {
                    return (
                      <div key={attr.key}>
                        <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                          {attr.label.toUpperCase()}
                          {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                        </span>
                        <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                          {attr.options.map(opt => (
                            <button key={opt} onClick={() => updateModalAttr(attr.key, opt)}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                border: `1px solid ${modalProduct.attributes?.[attr.key] === opt ? '#0F0F10' : '#D5D9DE'}`,
                                color: modalProduct.attributes?.[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                background: modalProduct.attributes?.[attr.key] === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
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
                        value={(modalProduct.attributes?.[attr.key] as string) || ''}
                        onChange={e => updateModalAttr(attr.key, attr.type === 'number' ? Number(e.target.value) : e.target.value)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Condition */}
          {modalSelectedCat && modalSelectedCat.conditionOptions.length > 0 && (
            <div>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
                CONDITION <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
              </span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {modalSelectedCat.conditionOptions.map(cond => (
                  <button key={cond} onClick={() => setModalProduct(p => ({ ...p, condition: cond }))}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${modalProduct.condition === cond ? '#0F0F10' : '#D5D9DE'}`,
                      color: modalProduct.condition === cond ? '#0F0F10' : '#6B7280',
                      background: modalProduct.condition === cond ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{cond}</button>
                ))}
              </div>
            </div>
          )}

          {/* Scope / Included */}
          {modalSelectedCat && modalSelectedCat.scopeOptions.length > 0 && (
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>INCLUDED</span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {modalSelectedCat.scopeOptions.map(item => {
                  const sel = (modalProduct.scopeOfDelivery || []).includes(item);
                  return (
                    <button key={item}
                      onClick={() => setModalProduct(p => {
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
          {modalProduct.categoryId && (
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <div>
                  <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                    Füllt Brand, Name, Kategorie-Felder und Description automatisch — alles bleibt editierbar.
                  </div>
                </div>
                <button disabled={modalAiBusy}
                  className="cursor-pointer transition-colors"
                  style={{
                    background: modalAiBusy ? '#6B7280' : '#0F0F10', color: '#FFFFFF',
                    border: 'none', borderRadius: 8, fontSize: 12, padding: '8px 14px',
                  }}
                  onClick={async () => {
                    const ai = await import('@/core/ai/ai-service');
                    if (!ai.isAiConfigured()) { alert('Set OpenAI API key in Settings > AI'); return; }
                    const hasImage = (modalProduct.images || []).length > 0;
                    const hasHints = !!modalProduct.brand || !!modalProduct.name || !!modalProduct.sku;
                    if (!hasImage && !hasHints) {
                      alert('Add a photo OR type a brand/name/reference hint first, then click AI Identify.');
                      return;
                    }
                    setModalAiBusy(true);
                    try {
                      const result = await ai.identifyProduct({
                        categoryId: modalProduct.categoryId as AiCategoryId,
                        imageBase64: hasImage ? modalProduct.images![0] : undefined,
                        hints: hasHints ? { brand: modalProduct.brand, name: modalProduct.name, reference: modalProduct.sku } : undefined,
                      });
                      setModalProduct(f => {
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
                    finally { setModalAiBusy(false); }
                  }}
                >{modalAiBusy ? 'Researching…' : 'AI Identify'}</button>
              </div>
            </div>
          )}

          {/* Photos */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span className="text-overline">PHOTOS</span>
              <span style={{ fontSize: 11, color: '#6B7280' }}>Add at least one photo for best AI results</span>
            </div>
            <ImageUpload images={modalProduct.images || []}
              onChange={imgs => setModalProduct(p => ({ ...p, images: imgs }))}
              maxImages={6} />
          </div>

          {/* Sale-Side Tax Scheme + Storage Location */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>TAX SCHEME (WHEN SOLD)</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(scheme => (
                  <button key={scheme} onClick={() => setModalProduct(p => ({ ...p, taxScheme: scheme }))}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${modalProduct.taxScheme === scheme ? '#0F0F10' : '#D5D9DE'}`,
                      color: modalProduct.taxScheme === scheme ? '#0F0F10' : '#6B7280',
                      background: modalProduct.taxScheme === scheme ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{scheme === 'MARGIN' ? 'Margin' : scheme === 'VAT_10' ? 'VAT 10%' : 'Zero'}</button>
                ))}
              </div>
            </div>
            <Input label="STORAGE LOCATION" placeholder="Safe, Shelf, Display..."
              value={modalProduct.storageLocation || ''}
              onChange={e => setModalProduct(p => ({ ...p, storageLocation: e.target.value }))} />
          </div>

          {/* Notes */}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea value={modalProduct.notes || ''}
              onChange={e => setModalProduct(p => ({ ...p, notes: e.target.value }))}
              rows={3} placeholder="Optional internal notes…"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, resize: 'vertical' }} />
          </div>

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setNewItemModalIdx(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleModalSave}
              disabled={!modalProduct.categoryId || !modalProduct.brand || !modalProduct.name}
            >
              <Save size={14} /> Use this Item
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
