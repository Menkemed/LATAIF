// Plan §Order — Full Page New Order Form (User-Spec).
// Sections: Customer / Order Items (multi) / Pricing / Payment / Delivery / Status / Summary / Actions.
// Plan §8 — Pricing-Section identisch zu Invoice: per-Line Tax-Scheme + auto VAT.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, X, Phone } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { useOrderStore } from '@/stores/orderStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { vatEngine } from '@/core/tax/vat-engine';
import { getStockAggregates } from '@/core/lots/lot-queries';
import type { OrderStatus, OrderType, CustomOrderMeta, MaterialDetails } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';
import { MaterialsCard, type MaterialLine } from '@/components/work-orders/MaterialsCard';
import { AddMaterialModal, type MaterialLineInput } from '@/components/work-orders/AddMaterialModal';
import { v4 as genId } from 'uuid';

type Scheme = 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

interface DraftLine {
  productId?: string;
  description: string;
  scheme: Scheme;
  quantity: number;
  unitPrice: number; // Netto pro Stück
}

function calcLine(unitPrice: number, qty: number, purchasePrice: number, scheme: 'VAT_10' | 'ZERO' | 'MARGIN', vatRate: number) {
  return vatEngine.calculateNet(unitPrice * qty, purchasePrice * qty, scheme, vatRate);
}

// Inverse: vom Gesamt-Brutto auf Netto-pro-Einheit zurückrechnen.
function unitNetFromGross(gross: number, qty: number, scheme: 'VAT_10' | 'ZERO' | 'MARGIN', vatRate: number): number {
  if (qty <= 0) return 0;
  const totalNet = scheme === 'VAT_10' ? gross / (1 + vatRate / 100) : gross;
  return totalNet / qty;
}

const ALLOWED_STATUSES: OrderStatus[] = ['pending', 'arrived', 'notified', 'completed'];
const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  arrived: 'Arrived',
  notified: 'Notified',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function OrderCreate() {
  const navigate = useNavigate();
  const goBack = useGoBack('/orders');
  const { createOrder } = useOrderStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts } = useProductStore();
  const { suppliers, loadSuppliers } = useSupplierStore();

  useEffect(() => { loadCustomers(); loadProducts(); loadSuppliers(); }, [loadCustomers, loadProducts, loadSuppliers]);

  const [searchParams] = useSearchParams();
  const [customerId, setCustomerId] = useState(searchParams.get('customer') || '');
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);

  // v0.2.1 — Order Type Discriminator
  const [orderType, setOrderType] = useState<OrderType>('normal');

  // v0.2.1 — Custom-Order State
  const [customerGoldGrams, setCustomerGoldGrams] = useState('');
  const [customerGoldKarat, setCustomerGoldKarat] = useState('22K');
  const [customerStones, setCustomerStones] = useState('');
  const [goldsmithSupplierId, setGoldsmithSupplierId] = useState('');
  const [laborCost, setLaborCost] = useState('');
  const [laborCustomerPrice, setLaborCustomerPrice] = useState('');
  const [laborShowMarkup, setLaborShowMarkup] = useState(false);
  const [extraGoldGrams, setExtraGoldGrams] = useState('');
  const [extraGoldKarat, setExtraGoldKarat] = useState('22K');
  const [extraGoldCost, setExtraGoldCost] = useState('');
  const [extraGoldCustomerPrice, setExtraGoldCustomerPrice] = useState('');
  const [extraGoldShowMarkup, setExtraGoldShowMarkup] = useState(false);
  const [finalProductDescription, setFinalProductDescription] = useState('');
  // Diamond/Stone Materials werden lokal als Liste gefuehrt — beim createOrder
  // werden sie als order_lines mit material_kind/material_details persistiert.
  const [materialLines, setMaterialLines] = useState<Array<MaterialLineInput & { _id: string }>>([]);
  const [showAddMaterial, setShowAddMaterial] = useState(false);

  const [lines, setLines] = useState<DraftLine[]>([
    { description: '', scheme: 'auto', quantity: 1, unitPrice: 0 },
  ]);
  // Locale string state per line for the editable Total input — preserves trailing zeros
  // and decimal points while user types (e.g. "5500.50" stays as typed).
  const [lineTotalDrafts, setLineTotalDrafts] = useState<Record<number, string>>({});
  const [depositAmount, setDepositAmount] = useState<number>(0);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank' | 'card' | 'benefit'>('cash');
  const [fullyPaid, setFullyPaid] = useState(false);
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [status, setStatus] = useState<OrderStatus>('pending');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const customer = useMemo(() => customers.find(c => c.id === customerId), [customers, customerId]);
  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`,
    subtitle: c.phone,
  })), [customers]);
  const productOptions = useMemo(() => products.map(p => ({
    id: p.id,
    label: `${p.brand} ${p.name}${p.sku ? ' · ' + p.sku : ''}`,
    subtitle: `${fmt(p.plannedSalePrice ?? p.purchasePrice ?? 0)} BHD`,
  })), [products]);

  // Phase 7 — Lot-Aggregate fuer alle in lines referenzierten Produkte cachen,
  // damit Cost-Basis fuer Margin-Scheme aus dem FIFO-Lot kommt (= naechster Sale-Cost)
  // statt aus dem irrefuehrenden single product.purchase_price.
  const lotAgg = useMemo(() => {
    const ids = lines.map(l => l.productId).filter((x): x is string => Boolean(x));
    return getStockAggregates(ids);
  }, [lines]);

  // Pro Zeile auflösen: Scheme + VAT + Net + Gross (genau wie Invoice).
  const computed = lines.map(l => {
    const product = l.productId ? products.find(p => p.id === l.productId) : undefined;
    const fallbackScheme: 'VAT_10' | 'ZERO' | 'MARGIN' = (product?.taxScheme as 'VAT_10' | 'ZERO' | 'MARGIN') || 'MARGIN';
    const resolved = l.scheme === 'auto' ? fallbackScheme : l.scheme;
    const vatRate = resolved === 'ZERO' ? 0 : 10;
    const agg = product ? lotAgg.get(product.id) : undefined;
    // FIFO-Cost wenn aktive Lots vorhanden — sonst product.purchase_price-Fallback.
    // (weightedAvg = totalValue / totalQty; reicht hier als Margin-Vorschau)
    const purchase = agg && agg.totalQty > 0 ? agg.weightedAvg : (product?.purchasePrice || 0);
    const calc = calcLine(l.unitPrice, l.quantity, purchase, resolved, vatRate);
    return {
      product, scheme: resolved, vatRate,
      net: calc.netAmount, vat: calc.vatAmount,
      internalVat: calc.internalVatAmount || 0, // MARGIN: VAT auf Profit (intern)
      gross: calc.grossAmount,
    };
  });

  const subtotal = computed.reduce((s, c) => s + c.net, 0);
  const totalVat = computed.reduce((s, c) => s + c.vat, 0);
  const total = subtotal + totalVat;
  const remaining = Math.max(0, total - (fullyPaid ? total : depositAmount));

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  function addLine() {
    setLines(prev => [...prev, { description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }]);
  }

  function removeLine(idx: number) {
    setLines(prev => prev.filter((_, i) => i !== idx));
  }

  function pickProductForLine(idx: number, productId: string) {
    const p = products.find(pp => pp.id === productId);
    if (!p) return;
    updateLine(idx, {
      productId,
      description: `${p.brand} ${p.name}`,
      unitPrice: p.plannedSalePrice ?? p.purchasePrice ?? 0,
    });
  }

  function reset() {
    setCustomerId('');
    setLines([{ description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }]);
    setDepositAmount(0);
    setPaymentMethod('cash');
    setFullyPaid(false);
    setExpectedDelivery('');
    setStatus('pending');
    setNotes('');
    setError('');
  }

  function validate(): string | null {
    if (!customerId) return 'Please select a customer';
    if (orderType === 'custom') {
      // Custom-Order braucht mindestens eine Component (Labor / Extra-Gold / Material)
      const hasLabor = parseFloat(laborCost) > 0;
      const hasExtra = parseFloat(extraGoldCost) > 0;
      const hasMat = materialLines.length > 0;
      if (!hasLabor && !hasExtra && !hasMat) {
        return 'Custom Order braucht mindestens Labor, Extra-Gold ODER ein Material';
      }
      if (!finalProductDescription.trim()) {
        return 'Bitte Final-Product-Description angeben';
      }
      return null;
    }
    if (lines.length === 0) return 'Please add at least one item';
    const hasInvalid = lines.some(l => !l.description.trim() || l.quantity <= 0);
    if (hasInvalid) return 'Each item needs a description and quantity > 0';
    return null;
  }

  // v0.2.1 — Build payload fuer Custom-Order. Erzeugt order_lines mit
  // supplier_id + cost_amount + material_kind je nach Komponente.
  function buildCustomPayload() {
    const customLines: Array<{
      description: string;
      quantity: number;
      unitPrice: number;
      taxScheme?: 'VAT_10' | 'ZERO' | 'MARGIN';
      vatRate?: number;
      supplierId?: string;
      costAmount?: number;
      isCustomerFacing?: boolean;
      materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | null;
      materialDetails?: MaterialDetails;
    }> = [];

    // Goldsmith Labor Line
    const laborCostNum = parseFloat(laborCost) || 0;
    if (laborCostNum > 0) {
      const laborPrice = laborShowMarkup ? (parseFloat(laborCustomerPrice) || laborCostNum) : laborCostNum;
      const supName = goldsmithSupplierId ? suppliers.find(s => s.id === goldsmithSupplierId)?.name : undefined;
      customLines.push({
        description: `Goldsmith Labor${supName ? ' — ' + supName : ''}`,
        quantity: 1,
        unitPrice: laborPrice,
        taxScheme: 'VAT_10',
        vatRate: 10,
        supplierId: goldsmithSupplierId || undefined,
        costAmount: laborCostNum,
        isCustomerFacing: true,
        materialKind: 'labor',
      });
    }

    // Extra Gold Line
    const extraCostNum = parseFloat(extraGoldCost) || 0;
    const extraGramsNum = parseFloat(extraGoldGrams) || 0;
    if (extraCostNum > 0) {
      const extraPrice = extraGoldShowMarkup ? (parseFloat(extraGoldCustomerPrice) || extraCostNum) : extraCostNum;
      customLines.push({
        description: `Extra Gold ${extraGramsNum > 0 ? extraGramsNum.toFixed(3) + 'g ' + extraGoldKarat : ''}`.trim(),
        quantity: 1,
        unitPrice: extraPrice,
        taxScheme: 'VAT_10',
        vatRate: 10,
        costAmount: extraCostNum,
        isCustomerFacing: true,
        materialKind: 'gold',
        materialDetails: { weightGrams: extraGramsNum, karat: extraGoldKarat },
      });
    }

    // Material-Lines (Diamond / Stone / Gold-Piece)
    for (const m of materialLines) {
      const customerPrice = m.customerPrice ?? m.totalCost;
      const supName = m.supplierId ? suppliers.find(s => s.id === m.supplierId)?.name : m.supplierName;
      const ctLabel = (m.materialKind === 'diamond' || m.materialKind === 'stone')
        ? `${m.quantity}× ${(m.caratPerPiece || 0).toFixed(2)}ct `
        : '';
      customLines.push({
        description: `${ctLabel}${m.description}${supName ? ' — ' + supName : ''}`,
        quantity: 1,
        unitPrice: customerPrice,
        taxScheme: 'VAT_10',
        vatRate: 10,
        supplierId: m.supplierId,
        costAmount: m.totalCost,
        isCustomerFacing: true,
        materialKind: m.materialKind,
        materialDetails: {
          ct: m.caratPerPiece,
          qty: m.quantity,
          description: m.description,
          karat: m.karat,
          weightGrams: m.weightGrams,
          supplierName: supName,
        },
      });
    }

    // Total = SUM of customer-facing unitPrice * quantity
    const customTotal = customLines.reduce((s, l) => s + (l.unitPrice * l.quantity), 0);

    // Custom-Meta
    const customGoldNum = parseFloat(customerGoldGrams) || 0;
    const customMeta: CustomOrderMeta = {
      customerGoldWeight: customGoldNum > 0 ? customGoldNum : undefined,
      customerGoldKarat: customGoldNum > 0 ? customerGoldKarat : undefined,
      customerStones: customerStones.trim() || undefined,
      finalProductDescription: finalProductDescription.trim() || undefined,
      customerMaterialReceivedAt: customGoldNum > 0 ? new Date().toISOString().split('T')[0] : undefined,
      diamondDetails: materialLines
        .filter(m => m.materialKind === 'diamond' || m.materialKind === 'stone')
        .map(m => ({
          description: m.description,
          quantity: m.quantity,
          caratPerPiece: m.caratPerPiece || 0,
          totalCost: m.totalCost,
          customerPrice: m.customerPrice ?? m.totalCost,
          supplierId: m.supplierId,
        })),
    };

    return {
      customerId,
      type: 'custom' as OrderType,
      customMeta,
      goldsmithSupplierId: goldsmithSupplierId || undefined,
      laborCost: laborCostNum,
      extraGoldValue: extraCostNum,
      requestedBrand: 'Custom Order',
      requestedModel: finalProductDescription.trim() || 'Sonderanfertigung',
      requestedDetails: customGoldNum > 0
        ? `Customer-Gold ${customGoldNum}g ${customerGoldKarat}`
        : undefined,
      agreedPrice: customTotal,
      depositAmount: fullyPaid ? customTotal : depositAmount,
      depositPaid: depositAmount > 0 || fullyPaid,
      depositDate: depositAmount > 0 || fullyPaid ? new Date().toISOString().split('T')[0] : undefined,
      paymentMethod,
      fullyPaid,
      expectedDelivery: expectedDelivery || undefined,
      status,
      notes: notes || undefined,
      lines: customLines,
    };
  }

  function buildPayload() {
    const first = lines[0];
    const product = first?.productId ? products.find(p => p.id === first.productId) : undefined;
    // Per-Line auch Scheme + VatRate persistieren — sonst ginge die in dieser
    // Maske gewählte Steuer beim Save verloren und Convert-to-Invoice müsste
    // erneut fragen / könnte falsch rechnen.
    const draftLines = lines.map((l, i) => ({
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxScheme: computed[i].scheme,
      vatRate: computed[i].vatRate,
    }));
    return {
      customerId,
      lines: draftLines,
      // Legacy single-item Felder aus erster Line (für Anzeige in alter UI)
      requestedBrand: product?.brand || first?.description.split(' ')[0] || '',
      requestedModel: product?.name || first?.description || '',
      requestedReference: product?.sku,
      requestedDetails: lines.length > 1 ? `${lines.length} items` : undefined,
      categoryId: product?.categoryId,
      attributes: product?.attributes,
      condition: product?.condition,
      existingProductId: product?.id,
      agreedPrice: total,
      taxAmount: totalVat,
      depositAmount: fullyPaid ? total : depositAmount,
      depositPaid: depositAmount > 0 || fullyPaid,
      depositDate: depositAmount > 0 || fullyPaid ? new Date().toISOString().split('T')[0] : undefined,
      paymentMethod,
      fullyPaid,
      expectedDelivery: expectedDelivery || undefined,
      status,
      notes: notes || undefined,
    };
  }

  function handleSave(continueEditing: boolean) {
    setError('');
    const v = validate();
    if (v) { setError(v); return; }
    const payload = orderType === 'custom' ? buildCustomPayload() : buildPayload();
    const order = createOrder(payload);
    if (continueEditing) {
      reset();
    } else {
      navigate(`/orders/${order.id}`);
    }
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 80px', maxWidth: 1500 }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <div>
            <button onClick={goBack}
              className="flex items-center gap-2 cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13, marginBottom: 8 }}>
              <ArrowLeft size={16} /> Back
            </button>
            <h1 className="font-display" style={{ fontSize: 30, color: '#0F0F10', lineHeight: 1.2 }}>New Order</h1>
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Complete order with customer, items, pricing, and payment.</p>
          </div>
        </div>

        {/* 1. CUSTOMER SECTION */}
        <Card>
          <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>1 · CUSTOMER</span>
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

        {/* v0.2.1 — Order Type Picker (Normal vs Custom) */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>2 · ORDER TYPE</span>
            <div className="flex gap-3">
              {(['normal', 'custom'] as OrderType[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setOrderType(t)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '12px 24px', fontSize: 14, fontWeight: 500,
                    border: `1px solid ${orderType === t ? '#0F0F10' : '#D5D9DE'}`,
                    color: orderType === t ? '#0F0F10' : '#6B7280',
                    background: orderType === t ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}
                >
                  {t === 'normal' ? '📦 Normal Order' : '💎 Custom Order'}
                  <div style={{ fontSize: 11, fontWeight: 400, color: '#9CA3AF', marginTop: 4 }}>
                    {t === 'normal' ? 'Standard-Bestellung / Sourcing' : 'Goldsmith / Sonderanfertigung'}
                  </div>
                </button>
              ))}
            </div>
          </Card>
        </div>

        {/* v0.2.1 — Custom-Order conditional sections */}
        {orderType === 'custom' && (
          <>
            {/* Customer Material Card */}
            <div style={{ marginTop: 16 }}>
              <Card>
                <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>
                  3a · CUSTOMER MATERIAL (informational, kein Asset)
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 16 }}>
                  <Input
                    label="GOLD WEIGHT (G)"
                    type="number"
                    step="0.001"
                    placeholder="0.000"
                    value={customerGoldGrams}
                    onChange={e => setCustomerGoldGrams(e.target.value)}
                  />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>KARAT</span>
                    <div className="flex gap-1 flex-wrap">
                      {['24K', '22K', '21K', '18K'].map(k => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setCustomerGoldKarat(k)}
                          className="cursor-pointer rounded"
                          style={{
                            padding: '4px 8px', fontSize: 11,
                            border: `1px solid ${customerGoldKarat === k ? '#0F0F10' : '#D5D9DE'}`,
                            color: customerGoldKarat === k ? '#0F0F10' : '#6B7280',
                            background: customerGoldKarat === k ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}
                        >{k}</button>
                      ))}
                    </div>
                  </div>
                  <Input
                    label="STONES (OPTIONAL — freier Text)"
                    placeholder="2x 0.5ct round diamonds"
                    value={customerStones}
                    onChange={e => setCustomerStones(e.target.value)}
                  />
                </div>
                <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                  Wird als Memo-Block auf der Invoice gezeigt + in customer_gold_credits getrackt.
                </p>
              </Card>
            </div>

            {/* Goldsmith Work Card */}
            <div style={{ marginTop: 16 }}>
              <Card>
                <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3b · GOLDSMITH WORK / LABOR</span>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 16 }}>
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>SUPPLIER (OPTIONAL — A/P)</span>
                    <SearchSelect
                      options={suppliers.filter(s => s.active).map(s => ({
                        id: s.id, label: s.name, subtitle: s.phone || '', meta: s.email || '',
                      }))}
                      value={goldsmithSupplierId}
                      onChange={setGoldsmithSupplierId}
                      placeholder="Pick a goldsmith — or leave empty"
                    />
                  </div>
                  <Input
                    label="LABOR COST (BHD)"
                    type="number"
                    step="0.001"
                    placeholder="0.000"
                    value={laborCost}
                    onChange={e => setLaborCost(e.target.value)}
                  />
                  <div>
                    <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                      <span className="text-overline">CUSTOMER PRICE</span>
                      <button
                        type="button"
                        onClick={() => setLaborShowMarkup(!laborShowMarkup)}
                        style={{ fontSize: 10, color: '#3D7FFF', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        {laborShowMarkup ? 'Use 1:1' : 'Add markup'}
                      </button>
                    </div>
                    <Input
                      label=""
                      type="number"
                      step="0.001"
                      placeholder={laborShowMarkup ? '0.000' : '(same as cost)'}
                      value={laborShowMarkup ? laborCustomerPrice : laborCost}
                      onChange={e => setLaborCustomerPrice(e.target.value)}
                      disabled={!laborShowMarkup}
                    />
                  </div>
                </div>
              </Card>
            </div>

            {/* Extra Gold Card */}
            <div style={{ marginTop: 16 }}>
              <Card>
                <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3c · EXTRA GOLD (OUR STOCK / PURCHASED)</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16 }}>
                  <Input
                    label="WEIGHT (G)"
                    type="number"
                    step="0.001"
                    placeholder="0.000"
                    value={extraGoldGrams}
                    onChange={e => setExtraGoldGrams(e.target.value)}
                  />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>KARAT</span>
                    <div className="flex gap-1 flex-wrap">
                      {['24K', '22K', '21K', '18K'].map(k => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setExtraGoldKarat(k)}
                          className="cursor-pointer rounded"
                          style={{
                            padding: '4px 8px', fontSize: 11,
                            border: `1px solid ${extraGoldKarat === k ? '#0F0F10' : '#D5D9DE'}`,
                            color: extraGoldKarat === k ? '#0F0F10' : '#6B7280',
                            background: extraGoldKarat === k ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}
                        >{k}</button>
                      ))}
                    </div>
                  </div>
                  <Input
                    label="COST (BHD)"
                    type="number"
                    step="0.001"
                    placeholder="0.000"
                    value={extraGoldCost}
                    onChange={e => setExtraGoldCost(e.target.value)}
                  />
                  <div>
                    <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                      <span className="text-overline">CUSTOMER PRICE</span>
                      <button
                        type="button"
                        onClick={() => setExtraGoldShowMarkup(!extraGoldShowMarkup)}
                        style={{ fontSize: 10, color: '#3D7FFF', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        {extraGoldShowMarkup ? 'Use 1:1' : 'Add markup'}
                      </button>
                    </div>
                    <Input
                      label=""
                      type="number"
                      step="0.001"
                      placeholder={extraGoldShowMarkup ? '0.000' : '(same as cost)'}
                      value={extraGoldShowMarkup ? extraGoldCustomerPrice : extraGoldCost}
                      onChange={e => setExtraGoldCustomerPrice(e.target.value)}
                      disabled={!extraGoldShowMarkup}
                    />
                  </div>
                </div>
              </Card>
            </div>

            {/* Materials (Diamond/Stone/Gold-Piece) — uses shared component */}
            <div style={{ marginTop: 16 }}>
              <MaterialsCard
                title="3d · DIAMONDS / STONES / GOLD-PIECES"
                lines={materialLines.map(m => ({
                  id: m._id,
                  materialKind: m.materialKind,
                  materialDetails: {
                    ct: m.caratPerPiece,
                    qty: m.quantity,
                    description: m.description,
                    karat: m.karat,
                    weightGrams: m.weightGrams,
                    supplierName: m.supplierName,
                  },
                  description: m.description,
                  supplierId: m.supplierId,
                  supplierName: m.supplierName,
                  costAmount: m.totalCost,
                  unitPrice: m.customerPrice ?? m.totalCost,
                } as MaterialLine))}
                onAdd={() => setShowAddMaterial(true)}
                showCustomerPrice={true}
                canEdit={true}
              />
            </div>

            {/* Final Product Description */}
            <div style={{ marginTop: 16 }}>
              <Card>
                <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3e · FINAL PRODUCT / OUTPUT</span>
                <Input
                  label="FINAL PRODUCT DESCRIPTION"
                  placeholder="e.g. Custom 22K wedding ring with 0.5ct center diamond"
                  value={finalProductDescription}
                  onChange={e => setFinalProductDescription(e.target.value)}
                />
              </Card>
            </div>
          </>
        )}

        {/* 2. ORDER ITEMS SECTION (nur fuer Normal-Orders) */}
        {orderType === 'normal' && <div style={{ marginTop: 16 }}>
          <Card>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span className="text-overline">3 · ORDER ITEMS</span>
              <Button variant="secondary" onClick={addLine}><Plus size={12} /> Add Item</Button>
            </div>
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) 56px minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.1fr) 44px',
                gap: 10, padding: '10px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE',
                fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span>Product / Description</span>
                <span>Tax Scheme</span>
                <span style={{ textAlign: 'center' }}>Qty</span>
                <span style={{ textAlign: 'right' }}>Net / Unit (BHD)<br/><span style={{ fontSize: 9, color: '#9CA3AF', textTransform: 'none', letterSpacing: 0 }}>auto</span></span>
                <span style={{ textAlign: 'right' }}>VAT (BHD)<br/><span style={{ fontSize: 9, color: '#9CA3AF', textTransform: 'none', letterSpacing: 0 }}>auto</span></span>
                <span style={{ textAlign: 'right' }}>Total Price incl. VAT (BHD)<br/><span style={{ fontSize: 9, color: '#9CA3AF', textTransform: 'none', letterSpacing: 0 }}>enter total</span></span>
                <span></span>
              </div>
              {lines.map((l, idx) => {
                const c = computed[idx];
                return (
                  <div key={idx} style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) 56px minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.1fr) 44px',
                    gap: 10, padding: '10px 12px', borderBottom: '1px solid #E5E9EE', alignItems: 'center',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <SearchSelect
                        placeholder="Pick product or type free text"
                        options={productOptions}
                        value={l.productId || ''}
                        onChange={pid => pickProductForLine(idx, pid)}
                      />
                      <input
                        placeholder="Description"
                        value={l.description}
                        onChange={e => updateLine(idx, { description: e.target.value })}
                        style={{ marginTop: 6, width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, minWidth: 0 }} />
                    </div>
                    <select value={l.scheme}
                      onChange={e => updateLine(idx, { scheme: e.target.value as Scheme })}
                      style={{ padding: '7px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF', minWidth: 0, width: '100%' }}>
                      <option value="auto">Auto ({c.product?.taxScheme || 'MARGIN'})</option>
                      <option value="VAT_10">VAT 10%</option>
                      <option value="ZERO">Zero</option>
                      <option value="MARGIN">Margin</option>
                    </select>
                    <input type="number" min={1} step="1" value={l.quantity}
                      onChange={e => updateLine(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="font-mono"
                      style={{ padding: '8px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 4, textAlign: 'right', minWidth: 0, width: '100%' }} />
                    <span className="font-mono" style={{ padding: '8px 10px', fontSize: 13, color: '#4B5563', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 4, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Bhd v={c.net / Math.max(1, l.quantity)}/>
                    </span>
                    {c.scheme === 'MARGIN' ? (
                      <span className="font-mono" title="Internal VAT liability on margin (not shown to customer)"
                        style={{ padding: '8px 10px', fontSize: 13, color: '#FF8730', background: 'rgba(255,135,48,0.06)', border: '1px solid rgba(255,135,48,0.25)', borderRadius: 4, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Bhd v={c.internalVat}/>
                        <span style={{ fontSize: 9, color: '#FF8730', marginLeft: 4, opacity: 0.7 }}>int</span>
                      </span>
                    ) : (
                      <span className="font-mono" style={{ padding: '8px 10px', fontSize: 13, color: '#4B5563', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 4, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Bhd v={c.vat}/>
                      </span>
                    )}
                    <input type="text" inputMode="decimal"
                      value={lineTotalDrafts[idx] !== undefined ? lineTotalDrafts[idx] : (Number.isFinite(c.gross) ? c.gross.toFixed(2) : '0')}
                      onChange={e => {
                        const raw = e.target.value;
                        // Erlaubt nur Ziffern + ein Punkt (oder Komma → ersetzt)
                        const sanitized = raw.replace(/,/g, '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
                        setLineTotalDrafts(d => ({ ...d, [idx]: sanitized }));
                        const newGross = parseFloat(sanitized) || 0;
                        const unit = unitNetFromGross(newGross, l.quantity, c.scheme, c.vatRate);
                        updateLine(idx, { unitPrice: unit });
                      }}
                      onBlur={() => {
                        // On blur: clean up draft, let memo-rendered value take over
                        setLineTotalDrafts(d => { const next = { ...d }; delete next[idx]; return next; });
                      }}
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
        </div>}

        {/* 3. PRICING SECTION — identisch zu Invoice (Net · VAT · Total auto) */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3 · PRICING (NET · VAT · TOTAL)</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NET (SUM)</span>
                <div className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}>
                  <Bhd v={subtotal}/> <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>VAT</span>
                <div className="font-display" style={{ fontSize: 22, color: '#AA956E' }}>
                  <Bhd v={totalVat}/> <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>TOTAL</span>
                <div className="font-display" style={{ fontSize: 26, color: '#C6A36D' }}>
                  <Bhd v={total}/> <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* 4. PAYMENT SECTION */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>4 · PAYMENT</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <Input label="DEPOSIT AMOUNT (BHD)" type="number" step="0.001"
                value={fullyPaid ? total : (depositAmount || '')}
                disabled={fullyPaid}
                onChange={e => setDepositAmount(parseFloat(e.target.value) || 0)} />
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAYMENT METHOD</span>
                <div className="flex gap-2" style={{ marginTop: 6 }}>
                  {(['cash', 'bank', 'card', 'benefit'] as const).map(m => {
                    const active = paymentMethod === m;
                    return (
                      <button key={m} type="button" onClick={() => setPaymentMethod(m)}
                        className="cursor-pointer rounded"
                        style={{ padding: '8px 16px', fontSize: 13,
                          border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                          color: active ? '#0F0F10' : '#6B7280',
                          background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : m === 'card' ? 'Card' : 'Benefit'}</button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 13, color: '#0F0F10' }}>
                <input type="checkbox" checked={fullyPaid}
                  onChange={e => {
                    setFullyPaid(e.target.checked);
                    if (e.target.checked) setStatus('completed');
                  }} />
                Fully Paid — Order direkt auf <strong>Completed</strong> setzen
              </label>
            </div>
          </Card>
        </div>

        {/* 5. DELIVERY SECTION */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>5 · DELIVERY</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
              <Input label="EXPECTED DELIVERY DATE" type="date"
                value={expectedDelivery} onChange={e => setExpectedDelivery(e.target.value)} />
              <div />
            </div>
          </Card>
        </div>

        {/* 6. STATUS SECTION */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>6 · STATUS</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 12 }}>
              {ALLOWED_STATUSES.map(s => {
                const active = status === s;
                return (
                  <button key={s} type="button" onClick={() => setStatus(s)}
                    className="cursor-pointer rounded"
                    style={{ padding: '8px 16px', fontSize: 12,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{STATUS_LABELS[s]}</button>
                );
              })}
            </div>
          </Card>
        </div>

        {/* Notes */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="z.B. Spezial-Wünsche, Termine, Lieferdetails…"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, resize: 'vertical' }} />
          </Card>
        </div>

        {/* 7. SUMMARY BOX */}
        <div style={{ marginTop: 24, padding: '20px 24px', background: 'linear-gradient(135deg, #1A1A1F 0%, #08080A 100%)', borderRadius: 12, border: '1px solid #2A2A30', color: '#FFFFFF' }}>
          <span style={{ fontSize: 11, color: '#8E8E97', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Summary</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>AGREED PRICE</div>
              <div className="font-mono" style={{ fontSize: 18, color: '#FFFFFF' }}><Bhd v={total}/> BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>DEPOSIT</div>
              <div className="font-mono" style={{ fontSize: 18, color: '#7EAA6E' }}><Bhd v={fullyPaid ? total : depositAmount}/> BHD</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#8E8E97', marginBottom: 4 }}>REMAINING</div>
              <div className="font-mono" style={{ fontSize: 18, color: remaining > 0 ? '#AA956E' : '#7EAA6E' }}><Bhd v={remaining}/> BHD</div>
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

        {/* 8. ACTION BUTTONS */}
        <div className="flex justify-between" style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={() => navigate('/orders')}><X size={14} /> Cancel</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => handleSave(true)}>Save &amp; New</Button>
            <Button variant="primary" onClick={() => handleSave(false)}><Save size={14} /> Save Order</Button>
          </div>
        </div>
      </div>

      <QuickCustomerModal open={showQuickCustomer} onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => { loadCustomers(); setCustomerId(id); }} />

      {/* v0.2.1 — Add Material Modal (Custom-Order mode) */}
      <AddMaterialModal
        open={showAddMaterial}
        onClose={() => setShowAddMaterial(false)}
        onSubmit={(data) => {
          setMaterialLines(prev => [...prev, { ...data, _id: genId() }]);
        }}
        showCustomerPrice={true}
      />
    </div>
  );
}
