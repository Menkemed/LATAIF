// Plan §Sales — Full-Page Invoice Create + Edit (User-Spec).
// Sections: Customer / Products / Tax / Pricing / Payment / Invoice Type / Summary / Actions.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, Printer, X, Phone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { vatEngine } from '@/core/tax/vat-engine';

type Scheme = 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN';
type Method = 'cash' | 'bank_transfer' | 'card';

interface DraftLine {
  productId: string;
  scheme: Scheme;
  quantity: number;
  unitPrice: number; // Netto pro Stück
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calcLine(unitPrice: number, qty: number, purchasePrice: number, scheme: 'VAT_10' | 'ZERO' | 'MARGIN', vatRate: number) {
  // calculateNet erwartet Netto pro Position — multiplizieren mit qty
  const calc = vatEngine.calculateNet(unitPrice * qty, purchasePrice * qty, scheme, vatRate);
  return calc;
}

// Inverse: vom Gesamt-Brutto auf Netto-pro-Einheit zurückrechnen.
// VAT_10  → net = gross / 1.10
// ZERO    → net = gross
// MARGIN  → net = gross (VAT ist auf Marge eingebettet, kundenseitig nicht extra)
function unitNetFromGross(gross: number, qty: number, scheme: 'VAT_10' | 'ZERO' | 'MARGIN', vatRate: number): number {
  if (qty <= 0) return 0;
  const totalNet = scheme === 'VAT_10' ? gross / (1 + vatRate / 100) : gross;
  return totalNet / qty;
}

export function InvoiceCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { id: editId } = useParams<{ id: string }>();
  const isEditMode = !!editId;
  const { invoices, loadInvoices, createDirectInvoice, recordPayment, updateInvoice, rewriteInvoiceLines, getInvoicePayments } = useInvoiceStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();

  useEffect(() => { loadCustomers(); loadProducts(); loadCategories(); if (isEditMode) loadInvoices(); }, [loadCustomers, loadProducts, loadCategories, loadInvoices, isEditMode]);

  const editInvoice = useMemo(() => isEditMode ? invoices.find(i => i.id === editId) : undefined, [isEditMode, editId, invoices]);

  const [customerId, setCustomerId] = useState(searchParams.get('customer') || '');
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [issuedDate, setIssuedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [lines, setLines] = useState<DraftLine[]>([
    { productId: '', scheme: 'auto', quantity: 1, unitPrice: 0 },
  ]);
  // Local string state per line for editable Total — preserves trailing zeros while typing.
  const [lineTotalDrafts, setLineTotalDrafts] = useState<Record<number, string>>({});
  const [paymentMethod, setPaymentMethod] = useState<Method>('cash');
  const [paidAmount, setPaidAmount] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [hydrated, setHydrated] = useState(!isEditMode);
  const [originalPaid, setOriginalPaid] = useState<number>(0);

  // Edit-Modus: einmalig Invoice + Lines + Payments in Form laden.
  useEffect(() => {
    if (!isEditMode || !editInvoice || hydrated) return;
    setCustomerId(editInvoice.customerId);
    setNotes(editInvoice.notes || '');
    if (editInvoice.issuedAt) setIssuedDate(editInvoice.issuedAt.slice(0, 10));
    const invLines = (editInvoice.lines || []).map(l => {
      const p = products.find(pp => pp.id === l.productId);
      const stored = (l.taxScheme as Scheme | undefined);
      const matchesProduct = stored && p && stored === p.taxScheme;
      const qty = l.quantity || 1;
      const unitNet = qty > 0 ? (l.unitPrice || 0) : 0;
      return {
        productId: l.productId || '',
        scheme: (matchesProduct ? 'auto' : (stored || 'auto')) as Scheme,
        quantity: qty,
        unitPrice: unitNet,
      };
    });
    setLines(invLines.length > 0 ? invLines : [{ productId: '', scheme: 'auto', quantity: 1, unitPrice: 0 }]);
    setPaidAmount(editInvoice.paidAmount || 0);
    setOriginalPaid(editInvoice.paidAmount || 0);
    const payments = getInvoicePayments(editInvoice.id);
    if (payments.length > 0) {
      const m = payments[payments.length - 1].method as Method;
      if (m === 'cash' || m === 'bank_transfer' || m === 'card') setPaymentMethod(m);
    }
    setHydrated(true);
  }, [isEditMode, editInvoice, hydrated, products, getInvoicePayments]);

  const customer = useMemo(() => customers.find(c => c.id === customerId), [customers, customerId]);
  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`,
    subtitle: c.phone,
  })), [customers]);
  const productOptions = useMemo(() => products
    .filter(p => p.stockStatus !== 'sold')
    .map(p => ({
      id: p.id,
      label: `${p.brand} ${p.name}`,
      subtitle: `${fmt(p.plannedSalePrice ?? p.purchasePrice ?? 0)} BHD · stock ${p.quantity || 1}`,
      meta: p.sku,
    })), [products]);

  // Pro Zeile: aufgelöstes Scheme + Berechnung (Memo via direkter map)
  const computed = lines.map(l => {
    const product = products.find(p => p.id === l.productId);
    if (!product) {
      return { product: undefined, scheme: 'VAT_10' as const, vatRate: 10, net: 0, vat: 0, internalVat: 0, gross: 0 };
    }
    const resolved = (l.scheme === 'auto' ? (product.taxScheme as 'VAT_10' | 'ZERO' | 'MARGIN') : l.scheme);
    const vatRate = resolved === 'ZERO' ? 0 : 10;
    const calc = calcLine(l.unitPrice, l.quantity, product.purchasePrice || 0, resolved, vatRate);
    return {
      product, scheme: resolved, vatRate,
      net: calc.netAmount, vat: calc.vatAmount,
      internalVat: calc.internalVatAmount || 0, // MARGIN: VAT auf Profit (intern, nicht customer-sichtbar)
      gross: calc.grossAmount,
    };
  });

  const subtotal = computed.reduce((s, c) => s + c.net, 0);
  const totalVat = computed.reduce((s, c) => s + c.vat, 0);
  const total = subtotal + totalVat;
  const remaining = Math.max(0, total - paidAmount);
  const invoiceType: 'INV' | 'PINV' = paidAmount >= total && total > 0 ? 'INV' : 'PINV';

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  function pickProductForLine(idx: number, productId: string) {
    const p = products.find(pp => pp.id === productId);
    if (!p) return;
    updateLine(idx, {
      productId,
      unitPrice: p.plannedSalePrice ?? p.purchasePrice ?? 0,
    });
  }

  function addLine() {
    setLines(prev => [...prev, { productId: '', scheme: 'auto', quantity: 1, unitPrice: 0 }]);
  }

  function removeLine(idx: number) {
    setLines(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));
  }

  function validate(): string | null {
    if (!customerId) return 'Please select a customer';
    if (lines.length === 0) return 'Please add at least one product';
    const bad = lines.findIndex(l => !l.productId || l.quantity <= 0 || l.unitPrice < 0);
    if (bad !== -1) return `Line ${bad + 1}: pick a product, set qty > 0, price ≥ 0`;
    if (paidAmount < 0) return 'Paid amount cannot be negative';
    if (paidAmount > total) return `Paid (${fmt(paidAmount)}) exceeds total (${fmt(total)})`;
    return null;
  }

  function handleSave(thenPrint: boolean) {
    setError('');
    const v = validate();
    if (v) { setError(v); return; }

    const payload = lines.map((l, i) => {
      const c = computed[i];
      return {
        productId: l.productId,
        quantity: Math.max(1, l.quantity),
        unitPrice: c.net / Math.max(1, l.quantity), // Netto pro Stück (für Detail-View)
        purchasePrice: c.product?.purchasePrice || 0,
        taxScheme: c.scheme,
        vatRate: c.vatRate,
        vatAmount: c.vat,
        lineTotal: c.gross,
      };
    });

    if (isEditMode && editInvoice) {
      // Edit-Modus: Customer/Notes/Datum updaten, Lines neu schreiben (recomputed totals),
      // Delta-Payment buchen falls paidAmount erhöht wurde.
      const issuedIso = `${issuedDate}T00:00:00.000Z`;
      updateInvoice(editInvoice.id, { customerId, notes: notes || undefined, issuedAt: issuedIso });
      rewriteInvoiceLines(editInvoice.id, payload);
      const delta = paidAmount - originalPaid;
      if (delta > 0.001) {
        recordPayment(editInvoice.id, delta, paymentMethod);
      }
      if (thenPrint) {
        navigate(`/invoices/${editInvoice.id}?print=1`);
      } else {
        navigate(`/invoices/${editInvoice.id}`);
      }
      return;
    }

    const inv = createDirectInvoice(customerId, payload, notes || undefined, issuedDate);
    if (!inv) { setError('Failed to create invoice'); return; }

    if (paidAmount > 0) {
      recordPayment(inv.id, paidAmount, paymentMethod);
    }

    if (thenPrint) {
      navigate(`/invoices/${inv.id}?print=1`);
    } else {
      navigate(`/invoices/${inv.id}`);
    }
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 80px', maxWidth: 1100 }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <div>
            <button onClick={() => navigate(isEditMode && editInvoice ? `/invoices/${editInvoice.id}` : '/invoices')}
              className="flex items-center gap-2 cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13, marginBottom: 8 }}>
              <ArrowLeft size={16} /> {isEditMode ? 'Invoice' : 'Invoices'}
            </button>
            <h1 className="font-display" style={{ fontSize: 30, color: '#0F0F10', lineHeight: 1.2 }}>
              {isEditMode ? `Edit Invoice ${editInvoice?.invoiceNumber || ''}` : 'Direct Sale'}
            </h1>
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
              {isEditMode ? 'Alle Felder bearbeitbar — Speichern überschreibt die Rechnung.' : 'Customer, products, tax, payment — all on one page.'}
            </p>
          </div>
          <span style={{
            padding: '6px 14px', borderRadius: 999, fontSize: 11, letterSpacing: '0.06em',
            background: invoiceType === 'INV' ? 'rgba(126,170,110,0.12)' : 'rgba(170,149,110,0.12)',
            color: invoiceType === 'INV' ? '#5C8550' : '#7A6B4F',
            border: `1px solid ${invoiceType === 'INV' ? 'rgba(126,170,110,0.4)' : 'rgba(170,149,110,0.4)'}`,
          }}>
            {invoiceType === 'INV' ? 'FINAL INVOICE (INV)' : 'PARTIAL INVOICE (PINV)'}
          </span>
        </div>

        {/* 1. CUSTOMER */}
        <Card>
          <div className="flex items-start justify-between" style={{ marginBottom: 12, gap: 16 }}>
            <span className="text-overline" style={{ display: 'block' }}>1 · CUSTOMER</span>
            <div style={{ minWidth: 160 }}>
              <span className="text-overline" style={{ display: 'block', marginBottom: 4 }}>INVOICE DATE</span>
              <input type="date" value={issuedDate} onChange={e => setIssuedDate(e.target.value)}
                style={{
                  padding: '6px 10px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 6,
                  background: '#FFFFFF', color: '#0F0F10', width: '100%',
                }}
                title="Default = today. Change for back-dated invoices." />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginTop: 12 }}>
            <div>
              <SearchSelect
                label="CUSTOMER"
                placeholder="Search clients..."
                options={customerOptions}
                value={customerId}
                onChange={setCustomerId}
              />
              <button onClick={() => setShowQuickCustomer(true)}
                className="cursor-pointer"
                style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, marginTop: 6, padding: 0 }}>
                + New Client
              </button>
            </div>
            {customer && (
              <div style={{ padding: '12px 14px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                <span style={{ fontSize: 11, color: '#6B7280', display: 'block', marginBottom: 4 }}>SELECTED</span>
                <div style={{ fontSize: 14, color: '#0F0F10' }}>{customer.firstName} {customer.lastName}</div>
                {customer.phone && (
                  <div className="flex items-center gap-1" style={{ marginTop: 4, fontSize: 12, color: '#6B7280' }}>
                    <Phone size={11} /> {customer.phone}
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* 2. PRODUCTS */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span className="text-overline">2 · PRODUCTS</span>
              <Button variant="secondary" onClick={addLine}><Plus size={12} /> Add Product</Button>
            </div>
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,2fr) minmax(0,0.9fr) minmax(0,1fr) 56px minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.1fr) 44px',
                gap: 10, padding: '10px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE',
                fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span>Product</span>
                <span>Category</span>
                <span>Tax Scheme</span>
                <span style={{ textAlign: 'center' }}>Qty</span>
                <span style={{ textAlign: 'right' }}>Net / Unit (BHD)<br/><span style={{ fontSize: 9, color: '#9CA3AF', textTransform: 'none', letterSpacing: 0 }}>auto</span></span>
                <span style={{ textAlign: 'right' }}>VAT (BHD)<br/><span style={{ fontSize: 9, color: '#9CA3AF', textTransform: 'none', letterSpacing: 0 }}>auto</span></span>
                <span style={{ textAlign: 'right' }}>Total Price incl. VAT (BHD)<br/><span style={{ fontSize: 9, color: '#9CA3AF', textTransform: 'none', letterSpacing: 0 }}>enter total</span></span>
                <span></span>
              </div>
              {lines.map((l, idx) => {
                const c = computed[idx];
                const cat = c.product ? categories.find(cc => cc.id === c.product?.categoryId) : undefined;
                return (
                  <div key={idx} style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,2fr) minmax(0,0.9fr) minmax(0,1fr) 56px minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.1fr) 44px',
                    gap: 10, padding: '10px 12px', borderBottom: '1px solid #E5E9EE', alignItems: 'center',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <SearchSelect
                        placeholder="Pick product..."
                        options={productOptions}
                        value={l.productId}
                        onChange={pid => pickProductForLine(idx, pid)}
                      />
                    </div>
                    <span style={{ fontSize: 12, color: cat ? cat.color : '#6B7280', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cat?.name || '—'}
                    </span>
                    <select value={l.scheme}
                      onChange={e => updateLine(idx, { scheme: e.target.value as Scheme })}
                      style={{ padding: '7px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF', minWidth: 0, width: '100%' }}>
                      <option value="auto">Auto ({c.product?.taxScheme || '—'})</option>
                      <option value="VAT_10">VAT 10%</option>
                      <option value="ZERO">Zero</option>
                      <option value="MARGIN">Margin</option>
                    </select>
                    <input type="number" min={1} step="1" value={l.quantity}
                      onChange={e => updateLine(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="font-mono"
                      style={{ padding: '8px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 4, textAlign: 'right', minWidth: 0, width: '100%' }} />
                    <span className="font-mono" style={{ padding: '8px 10px', fontSize: 13, color: '#4B5563', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 4, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {fmt(c.net / Math.max(1, l.quantity))}
                    </span>
                    {c.scheme === 'MARGIN' ? (
                      <span className="font-mono" title="Internal VAT liability on margin (not shown to customer)"
                        style={{ padding: '8px 10px', fontSize: 13, color: '#FF8730', background: 'rgba(255,135,48,0.06)', border: '1px solid rgba(255,135,48,0.25)', borderRadius: 4, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fmt(c.internalVat)}
                        <span style={{ fontSize: 9, color: '#FF8730', marginLeft: 4, opacity: 0.7 }}>int</span>
                      </span>
                    ) : (
                      <span className="font-mono" style={{ padding: '8px 10px', fontSize: 13, color: '#4B5563', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 4, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fmt(c.vat)}
                      </span>
                    )}
                    <input type="text" inputMode="decimal"
                      value={lineTotalDrafts[idx] !== undefined ? lineTotalDrafts[idx] : (Number.isFinite(c.gross) ? c.gross.toFixed(2) : '0')}
                      onChange={e => {
                        const sanitized = e.target.value.replace(/,/g, '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
                        setLineTotalDrafts(d => ({ ...d, [idx]: sanitized }));
                        const newGross = parseFloat(sanitized) || 0;
                        const unit = unitNetFromGross(newGross, l.quantity, c.scheme, c.vatRate);
                        updateLine(idx, { unitPrice: unit });
                      }}
                      onBlur={() => setLineTotalDrafts(d => { const next = { ...d }; delete next[idx]; return next; })}
                      className="font-mono"
                      style={{ padding: '8px 10px', fontSize: 13, border: '1px solid #0F0F10', borderRadius: 4, textAlign: 'right', minWidth: 0, width: '100%', fontWeight: 600 }} />
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
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
              Tax-Scheme „Auto&quot; übernimmt die Vorgabe vom Produkt. Manuell: VAT 10% / Zero / Margin pro Zeile.
            </p>
          </Card>
        </div>

        {/* 3. + 4. PRICING (Net / Tax / Total auf einen Blick) */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3 · PRICING (NET · TAX · TOTAL)</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NET (SUM)</span>
                <div className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}>
                  {fmt(subtotal)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>VAT</span>
                <div className="font-display" style={{ fontSize: 22, color: '#AA956E' }}>
                  {fmt(totalVat)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
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

        {/* 5. PAYMENT */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>4 · PAYMENT</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
                <div className="flex gap-2" style={{ marginTop: 6 }}>
                  {([
                    { id: 'cash', label: 'Cash' },
                    { id: 'bank_transfer', label: 'Bank' },
                    { id: 'card', label: 'Card' },
                  ] as const).map(m => {
                    const active = paymentMethod === m.id;
                    return (
                      <button key={m.id} type="button" onClick={() => setPaymentMethod(m.id)}
                        className="cursor-pointer rounded"
                        style={{ padding: '8px 16px', fontSize: 13,
                          border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                          color: active ? '#0F0F10' : '#6B7280',
                          background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{m.label}</button>
                    );
                  })}
                </div>
              </div>
              <Input label="PAID AMOUNT (BHD)" type="number" step="0.001"
                value={paidAmount || ''} onChange={e => setPaidAmount(parseFloat(e.target.value) || 0)} />
            </div>
            <div className="flex gap-2" style={{ marginTop: 14 }}>
              <button onClick={() => setPaidAmount(total)}
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Full
              </button>
              <button onClick={() => setPaidAmount(0)}
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Later
              </button>
            </div>
            {isEditMode && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(170,149,110,0.08)', border: '1px solid rgba(170,149,110,0.3)', borderRadius: 6, fontSize: 12, color: '#7A6B4F' }}>
                Bisher gezahlt: <strong>{fmt(originalPaid)} BHD</strong>. Wenn du den Betrag erhöhst, wird die Differenz als neue Zahlung gebucht. Bestehende Zahlungen werden nicht überschrieben — für detailliertes Payment-Management nutze die Detail-Seite.
              </div>
            )}
            <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                <span className="text-overline">PAID</span>
                <div className="font-mono" style={{ fontSize: 17, color: '#7EAA6E', marginTop: 4 }}>
                  {fmt(paidAmount)} BHD
                </div>
              </div>
              <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                <span className="text-overline">REMAINING</span>
                <div className="font-mono" style={{ fontSize: 17, color: remaining > 0 ? '#AA956E' : '#7EAA6E', marginTop: 4 }}>
                  {fmt(remaining)} BHD
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* 6. INVOICE TYPE (Auto, Anzeige) */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>5 · INVOICE TYPE</span>
            <div className="flex gap-3 items-center" style={{ marginTop: 12 }}>
              <span style={{
                padding: '8px 16px', borderRadius: 999, fontSize: 13,
                background: invoiceType === 'INV' ? 'rgba(126,170,110,0.12)' : 'rgba(170,149,110,0.12)',
                color: invoiceType === 'INV' ? '#5C8550' : '#7A6B4F',
                border: `1px solid ${invoiceType === 'INV' ? 'rgba(126,170,110,0.4)' : 'rgba(170,149,110,0.4)'}`,
              }}>
                {invoiceType === 'INV' ? 'FINAL INVOICE (INV)' : 'PARTIAL INVOICE (PINV)'}
              </span>
              <span style={{ fontSize: 12, color: '#6B7280' }}>
                Wird automatisch gesetzt: voll bezahlt → INV, sonst PINV. Bei späterer Vollzahlung promotet das System PINV → INV.
              </span>
            </div>
          </Card>
        </div>

        {/* Notes */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="z.B. Lieferdetails, Sonderwünsche…"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, resize: 'vertical' }} />
          </Card>
        </div>

        {/* 7. SUMMARY BOX */}
        <div style={{ marginTop: 24, padding: '20px 24px', background: 'linear-gradient(135deg, #1A1A1F 0%, #08080A 100%)', borderRadius: 12, border: '1px solid #2A2A30', color: '#FFFFFF' }}>
          <span style={{ fontSize: 11, color: '#8E8E97', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Summary</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>SUBTOTAL</div>
              <div className="font-mono" style={{ fontSize: 16, color: '#FFFFFF' }}>{fmt(subtotal)} BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>VAT</div>
              <div className="font-mono" style={{ fontSize: 16, color: '#C6A36D' }}>{fmt(totalVat)} BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>TOTAL</div>
              <div className="font-mono" style={{ fontSize: 18, color: '#FFFFFF' }}>{fmt(total)} BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>PAID</div>
              <div className="font-mono" style={{ fontSize: 16, color: '#7EAA6E' }}>{fmt(paidAmount)} BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>REMAINING</div>
              <div className="font-mono" style={{ fontSize: 16, color: remaining > 0 ? '#AA956E' : '#7EAA6E' }}>{fmt(remaining)} BHD</div>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, fontSize: 12, color: '#DC2626' }}>
            {error}
          </div>
        )}

        {/* 8. ACTION BUTTONS */}
        <div className="flex justify-between" style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={() => navigate(isEditMode && editInvoice ? `/invoices/${editInvoice.id}` : '/invoices')}><X size={14} /> Cancel</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => handleSave(true)}><Printer size={14} /> {isEditMode ? 'Save & Print' : 'Save & Print'}</Button>
            <Button variant="primary" onClick={() => handleSave(false)}><Save size={14} /> {isEditMode ? 'Save Changes' : 'Save Invoice'}</Button>
          </div>
        </div>
      </div>

      <QuickCustomerModal open={showQuickCustomer} onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => { loadCustomers(); setCustomerId(id); }} />
    </div>
  );
}
