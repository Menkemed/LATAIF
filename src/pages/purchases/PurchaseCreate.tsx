// Plan §Purchases — Full-Page New Purchase (wie Invoice/Order).
// Sections: Supplier / Items / Pricing / Initial Payment / Notes / Summary / Actions.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useProductStore } from '@/stores/productStore';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface DraftLine {
  mode: 'existing' | 'new';
  productId?: string;
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
  const { products, loadProducts, categories, loadCategories } = useProductStore();

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

  const subtotal = lines.reduce((s, l) => s + (l.quantity || 0) * (l.unitPrice || 0), 0);
  const total = subtotal;
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
      brand: p.brand,
      name: p.name,
      sku: p.sku || '',
      categoryId: p.categoryId,
      unitPrice: p.purchasePrice || 0,
    });
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
      ? { productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice }
      : {
          newProductBrand: l.brand,
          newProductName: l.name,
          newProductSku: l.sku || undefined,
          newProductCategoryId: l.categoryId || undefined,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
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
            <Input label="PURCHASE DATE" type="date"
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
                  {/* Source toggle */}
                  <select value={l.mode}
                    onChange={e => updateLine(idx, { mode: e.target.value as 'existing' | 'new', productId: undefined })}
                    style={{ padding: '7px 8px', fontSize: 11, border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF', minWidth: 0, width: '100%' }}>
                    <option value="new">New Item</option>
                    <option value="existing">Existing</option>
                  </select>

                  {/* Product picker or brand+name inputs */}
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
                    <div className="flex gap-2" style={{ minWidth: 0 }}>
                      <input placeholder="Brand" value={l.brand}
                        onChange={e => updateLine(idx, { brand: e.target.value })}
                        style={{ padding: '7px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, flex: 1, minWidth: 0, width: '100%' }} />
                      <input placeholder="Name / Model" value={l.name}
                        onChange={e => updateLine(idx, { name: e.target.value })}
                        style={{ padding: '7px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, flex: 2, minWidth: 0, width: '100%' }} />
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
              „New Item&quot; legt das Produkt direkt im Lager an. „Existing&quot; bucht nur zusätzliche Menge auf ein bestehendes Produkt.
            </p>
          </Card>
        </div>

        {/* 3. PRICING */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3 · PRICING</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>SUBTOTAL (FROM ITEMS)</span>
                <div className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}>
                  {fmt(subtotal)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>TOTAL</span>
                <div className="font-display" style={{ fontSize: 26, color: '#C6A36D' }}>
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
    </div>
  );
}
