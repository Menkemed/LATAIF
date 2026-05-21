// Plan §Order — Full Page New Order Form (User-Spec).
// Sections: Customer / Order Items (multi) / Pricing / Payment / Delivery / Status / Summary / Actions.
// Plan §8 — Pricing-Section identisch zu Invoice: per-Line Tax-Scheme + auto VAT.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, X, Phone, Edit3 } from 'lucide-react';
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
import { useGoldStore } from '@/stores/goldStore';
import { getSpotPrices } from '@/core/market/spot-prices';
import { purityOf } from '@/core/gold/purity';
import { vatEngine } from '@/core/tax/vat-engine';
import { getStockAggregates } from '@/core/lots/lot-queries';
import { productSearchText } from '@/core/utils/product-format';
import type { OrderStatus, OrderType, CustomOrderMeta, MaterialDetails, Product } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';
import { MaterialsCard, type MaterialLine } from '@/components/work-orders/MaterialsCard';
import { AddMaterialModal, type MaterialLineInput } from '@/components/work-orders/AddMaterialModal';
import { NewProductModal } from '@/components/products/NewProductModal';
import { v4 as genId } from 'uuid';

type Scheme = 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

interface DraftLine {
  // Back-to-Back: jede Produkt-Zeile ist entweder ein bestehendes Produkt
  // (Picker) oder ein neu definiertes (NewProductModal). brand/name aus
  // newProduct dienen nur der Inline-Anzeige; die volle Spec lebt in newProduct.
  mode: 'existing' | 'new';
  productId?: string;
  newProduct?: Partial<Product>;
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
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { createGoldPayable } = useGoldStore();

  useEffect(() => { loadCustomers(); loadProducts(); loadSuppliers(); loadCategories(); }, [loadCustomers, loadProducts, loadSuppliers, loadCategories]);
  // v0.6.0 — Live-Goldpreis fuer die provisorische COGS-Bewertung von
  // Goldschmied-Gold (wenn nur Gewicht, kein Cost eingegeben wird).
  useEffect(() => {
    getSpotPrices().then(r => { if (r.gold) setGoldRate(r.gold.bhdPerGram); }).catch(() => {});
  }, []);

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
  const [extraGoldGrams, setExtraGoldGrams] = useState('');
  const [extraGoldKarat, setExtraGoldKarat] = useState('22K');
  const [extraGoldCost, setExtraGoldCost] = useState('');
  // v0.6.0 — Goldschmied der sein eigenes Gold beisteuert → Gold-Verbindlichkeit
  // (Gramm) statt Geld. goldRate = Live-Goldpreis BHD/g (pure).
  const [extraGoldSupplierId, setExtraGoldSupplierId] = useState('');
  const [goldRate, setGoldRate] = useState(0);
  // v0.6.0 — Custom-Cards 3a-3d sind standardmaessig zu (Quote-first: nur der
  // Quoted Price in 3e ist Pflicht). Per Chip oeffnen wenn gebraucht.
  const [openCard, setOpenCard] = useState<Record<'3a' | '3b' | '3c' | '3d', boolean>>({
    '3a': false, '3b': false, '3c': false, '3d': false,
  });
  const [finalProductDescription, setFinalProductDescription] = useState('');
  // v0.5.0 — Quote-first: der approx. Preis den der Kunde akzeptiert. Kosten
  // (Labor/Diamond) sind optional und koennen spaeter auf der Detail-Seite rein.
  const [quotedPrice, setQuotedPrice] = useState('');
  // Diamond/Stone Materials werden lokal als Liste gefuehrt — beim createOrder
  // werden sie als order_lines mit material_kind/material_details persistiert.
  const [materialLines, setMaterialLines] = useState<Array<MaterialLineInput & { _id: string }>>([]);
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  // Back-to-Back: NewProductModal fuer "New"-Produkt-Zeilen (Index der Zeile).
  const [newItemModalIdx, setNewItemModalIdx] = useState<number | null>(null);

  const [lines, setLines] = useState<DraftLine[]>([
    { mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 },
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
    searchText: productSearchText(p),
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
    const fallbackScheme: 'VAT_10' | 'ZERO' | 'MARGIN' = ((product?.taxScheme || l.newProduct?.taxScheme) as 'VAT_10' | 'ZERO' | 'MARGIN') || 'MARGIN';
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

  // v0.5.0 — Custom/Mixed: der Quoted Price (approx.) ist eine MARGIN-Position
  // (gross == net) und fliesst direkt ins Pricing-Total ein.
  const quoteGross = (orderType === 'custom' || orderType === 'mixed')
    ? (parseFloat(quotedPrice) || 0)
    : 0;
  const subtotal = computed.reduce((s, c) => s + c.net, 0) + quoteGross;
  const totalVat = computed.reduce((s, c) => s + c.vat, 0);
  const total = subtotal + totalVat;
  const remaining = Math.max(0, total - (fullyPaid ? total : depositAmount));

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  function addLine() {
    setLines(prev => [...prev, { mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }]);
  }

  function removeLine(idx: number) {
    setLines(prev => prev.filter((_, i) => i !== idx));
  }

  function pickProductForLine(idx: number, productId: string) {
    const p = products.find(pp => pp.id === productId);
    if (!p) return;
    updateLine(idx, {
      productId,
      newProduct: undefined,
      description: `${p.brand} ${p.name}`,
      unitPrice: p.plannedSalePrice ?? p.purchasePrice ?? 0,
    });
  }

  function openNewItemModal(idx: number) {
    setNewItemModalIdx(idx);
  }

  function modalInitial(): Partial<Product> | undefined {
    if (newItemModalIdx == null) return undefined;
    const line = lines[newItemModalIdx];
    return line?.newProduct ?? {
      categoryId: categories[0]?.id || '',
      brand: '', name: '', sku: '', condition: '',
      taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD',
      attributes: {}, images: [],
    };
  }

  function handleModalSave(prod: Partial<Product>) {
    if (newItemModalIdx == null) return;
    const label = `${prod.brand || ''} ${prod.name || ''}`.trim();
    updateLine(newItemModalIdx, {
      newProduct: prod,
      productId: undefined,
      description: label,
    });
    setNewItemModalIdx(null);
  }

  function reset() {
    setCustomerId('');
    setLines([{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }]);
    setDepositAmount(0);
    setPaymentMethod('cash');
    setFullyPaid(false);
    setExpectedDelivery('');
    setStatus('pending');
    setNotes('');
    setError('');
    // v0.5.0 — Custom-Felder ebenfalls leeren
    setQuotedPrice('');
    setLaborCost('');
    setGoldsmithSupplierId('');
    setExtraGoldCost('');
    setExtraGoldGrams('');
    setExtraGoldSupplierId('');
    setCustomerGoldGrams('');
    setCustomerStones('');
    setFinalProductDescription('');
    setMaterialLines([]);
  }

  function hasProductLines(): boolean {
    return lines.some(l => l.productId || l.newProduct);
  }

  // v0.5.0 — Quote-first Validierung. Ein Custom-Order braucht nur den approx.
  // Preis + die Beschreibung; Labor-/Diamond-Kosten sind optional (kommen oft
  // erst spaeter rein, wenn das Stueck fertig ist).
  function validate(): string | null {
    if (!customerId) return 'Please select a customer';
    const wantsProduct = orderType === 'normal' || orderType === 'mixed';
    const wantsCustom = orderType === 'custom' || orderType === 'mixed';
    const quote = parseFloat(quotedPrice) || 0;

    if (wantsCustom && !wantsProduct) {
      // reiner Custom-Order
      if (quote <= 0) return 'Bitte einen Quoted Price (approx.) angeben';
      if (!finalProductDescription.trim()) return 'Bitte Final-Product-Description angeben';
      return null;
    }
    if (wantsProduct && !wantsCustom) {
      // reiner Normal-Order — jede Zeile ist Existing (Produkt) oder New (Spec).
      const realLines = lines.filter(l => l.productId || l.newProduct);
      if (realLines.length === 0) return 'Bitte mindestens einen Artikel waehlen (Existing) oder anlegen (New)';
      if (realLines.some(l => l.quantity <= 0)) return 'Jeder Artikel braucht eine Menge > 0';
      return null;
    }
    // Mixed: Customer + (≥1 Produkt-Line ODER Quoted Price)
    if (!hasProductLines() && quote <= 0) {
      return 'Mixed Order braucht mindestens ein Produkt ODER einen Quoted Price';
    }
    if (lines.filter(l => l.productId || l.newProduct).some(l => l.quantity <= 0)) {
      return 'Jeder Artikel braucht eine Menge > 0';
    }
    if (quote > 0 && !finalProductDescription.trim()) {
      return 'Bitte Final-Product-Description fuer den Custom-Teil angeben';
    }
    return null;
  }

  type UnifiedLine = {
    productId?: string;
    newProduct?: Partial<Product>;
    description: string;
    quantity: number;
    unitPrice: number;
    taxScheme?: 'VAT_10' | 'ZERO' | 'MARGIN';
    vatRate?: number;
    supplierId?: string;
    costAmount?: number;
    isCustomerFacing?: boolean;
    materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | 'custom' | null;
    materialDetails?: MaterialDetails;
  };

  // v0.3.0 — sammelt die normalen Produkt-Lines (kein materialKind).
  // Eine Zeile zaehlt nur wenn sie ein Produkt traegt (Existing oder New-Spec);
  // ueber den Original-Index gemappt, damit computed[] korrekt zugeordnet ist.
  function collectProductLines(): UnifiedLine[] {
    return lines
      .map((l, i) => ({ l, c: computed[i] }))
      .filter(({ l }) => l.productId || l.newProduct)
      .map(({ l, c }) => ({
        productId: l.productId,
        newProduct: l.newProduct,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxScheme: c.scheme,
        vatRate: c.vatRate,
      }));
  }

  // v0.3.0 — Custom-Meta separat (fuer Order.customMeta JSON).
  function collectCustomMeta(): CustomOrderMeta {
    const customGoldNum = parseFloat(customerGoldGrams) || 0;
    return {
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
  }

  // v0.5.0 — Quote-first: EINE kundenseitige Position (der approx. Preis als
  // MARGIN-Line) + optionale reine Kostenpositionen (Labor / Extra-Gold /
  // Materials) mit is_customer_facing = false. Der Quoted Price allein bestimmt
  // was der Kunde zahlt; die Kosten sind interne Buchhaltung (A/P + Marge).
  function collectCustomLines(): UnifiedLine[] {
    const customLines: UnifiedLine[] = [];

    // Quoted-Price-Line — die einzige kundenseitige Position des Custom-Teils.
    const quote = parseFloat(quotedPrice) || 0;
    if (quote > 0) {
      customLines.push({
        description: finalProductDescription.trim() || 'Custom Order',
        quantity: 1,
        unitPrice: quote,
        taxScheme: 'MARGIN',
        vatRate: 10,
        isCustomerFacing: true,
        materialKind: 'custom',
        costAmount: 0,
      });
    }

    // Goldsmith Labor — reine Kostenposition (cost-only, nicht auf der Invoice).
    const laborCostNum = parseFloat(laborCost) || 0;
    if (laborCostNum > 0) {
      const supName = goldsmithSupplierId ? suppliers.find(s => s.id === goldsmithSupplierId)?.name : undefined;
      customLines.push({
        description: `Goldsmith Labor${supName ? ' — ' + supName : ''}`,
        quantity: 1,
        unitPrice: 0,
        supplierId: goldsmithSupplierId || undefined,
        costAmount: laborCostNum,
        isCustomerFacing: false,
        materialKind: 'labor',
      });
    }

    // Extra Gold — reine Kostenposition (COGS-Beitrag). Bei Goldschmied-Gold
    // wird zusaetzlich (in handleSave) eine Gold-Verbindlichkeit angelegt; die
    // Cost-Line traegt NIE einen supplier → kein doppeltes Geld-A/P.
    // Cost = eingegebener Betrag, sonst Bewertung zum Live-Goldpreis × Reinheit.
    const extraCostNum = parseFloat(extraGoldCost) || 0;
    const extraGramsNum = parseFloat(extraGoldGrams) || 0;
    const extraGoldValue = extraCostNum > 0
      ? extraCostNum
      : (extraGramsNum > 0 && goldRate > 0
          ? Math.round(extraGramsNum * purityOf(extraGoldKarat) * goldRate * 1000) / 1000
          : 0);
    if (extraGoldValue > 0) {
      const sup = extraGoldSupplierId ? suppliers.find(s => s.id === extraGoldSupplierId) : undefined;
      customLines.push({
        description: `Extra Gold ${extraGramsNum > 0 ? extraGramsNum.toFixed(3) + 'g ' + extraGoldKarat : ''}${sup ? ' — ' + sup.name : ''}`.trim(),
        quantity: 1,
        unitPrice: 0,
        costAmount: extraGoldValue,
        isCustomerFacing: false,
        materialKind: 'gold',
        materialDetails: { weightGrams: extraGramsNum, karat: extraGoldKarat, supplierName: sup?.name },
      });
    }

    // Material-Lines (Diamond / Stone / Gold-Piece) — reine Kostenpositionen.
    for (const m of materialLines) {
      const supName = m.supplierId ? suppliers.find(s => s.id === m.supplierId)?.name : m.supplierName;
      const ctLabel = (m.materialKind === 'diamond' || m.materialKind === 'stone')
        ? `${m.quantity}× ${(m.caratPerPiece || 0).toFixed(2)}ct `
        : '';
      customLines.push({
        description: `${ctLabel}${m.description}${supName ? ' — ' + supName : ''}`,
        quantity: 1,
        unitPrice: 0,
        supplierId: m.supplierId,
        costAmount: m.totalCost,
        isCustomerFacing: false,
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

    return customLines;
  }

  // v0.3.0 — Unified Payload-Builder. Merged Produkt-Lines + Custom-Lines
  // je nach orderType. type wird vom Store aus den Lines abgeleitet.
  function buildOrderPayload() {
    const wantsProduct = orderType === 'normal' || orderType === 'mixed';
    const wantsCustom = orderType === 'custom' || orderType === 'mixed';
    const productLines = wantsProduct ? collectProductLines() : [];
    const customLines = wantsCustom ? collectCustomLines() : [];
    const allLines: UnifiedLine[] = [...productLines, ...customLines];

    // Total = SUM aller customer-facing Lines (cost-only exkludiert)
    const grandTotal = allLines
      .filter(l => l.isCustomerFacing !== false)
      .reduce((s, l) => s + (l.unitPrice * l.quantity), 0);

    const first = lines[0];
    const product = first?.productId ? products.find(p => p.id === first.productId) : undefined;
    const customMeta = wantsCustom ? collectCustomMeta() : undefined;
    const customGoldNum = parseFloat(customerGoldGrams) || 0;

    // Hero-Felder: bei reinem Normal aus erstem Produkt, sonst neutral
    const heroBrand = wantsCustom && !wantsProduct
      ? 'Custom Order'
      : (product?.brand || first?.description.split(' ')[0] || (orderType === 'mixed' ? 'Mixed Order' : ''));
    const heroModel = wantsCustom && !wantsProduct
      ? (finalProductDescription.trim() || 'Sonderanfertigung')
      : (product?.name || first?.description || (orderType === 'mixed' ? `${allLines.length} positions` : ''));

    return {
      customerId,
      lines: allLines,
      customMeta,
      goldsmithSupplierId: goldsmithSupplierId || undefined,
      laborCost: parseFloat(laborCost) || 0,
      extraGoldValue: parseFloat(extraGoldCost) || 0,
      requestedBrand: heroBrand,
      requestedModel: heroModel,
      requestedReference: !wantsCustom ? product?.sku : undefined,
      requestedDetails: customGoldNum > 0
        ? `Customer-Gold ${customGoldNum}g ${customerGoldKarat}`
        : (allLines.length > 1 ? `${allLines.length} positions` : undefined),
      categoryId: !wantsCustom ? product?.categoryId : undefined,
      attributes: !wantsCustom ? product?.attributes : undefined,
      condition: !wantsCustom ? product?.condition : undefined,
      existingProductId: !wantsCustom ? product?.id : undefined,
      agreedPrice: grandTotal,
      taxAmount: totalVat,
      depositAmount: fullyPaid ? grandTotal : depositAmount,
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
    const order = createOrder(buildOrderPayload());
    // v0.6.0 — Goldschmied-Gold → Gold-Verbindlichkeit (Gramm) an den Goldschmied,
    // verknuepft mit der Order. Wird auf der Detail-Seite in Gold oder Geld beglichen.
    const egGrams = parseFloat(extraGoldGrams) || 0;
    if (extraGoldSupplierId && egGrams > 0) {
      try {
        createGoldPayable({
          supplierId: extraGoldSupplierId,
          sourceOrderId: order.id,
          weightGrams: egGrams,
          karat: extraGoldKarat,
        });
      } catch (err) {
        console.error('[order] createGoldPayable failed:', err);
      }
    }
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

        {/* v0.3.0 — Order Type Picker (Normal / Custom / Mixed) */}
        <div style={{ marginTop: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>2 · ORDER TYPE</span>
            <div className="flex gap-3">
              {(['normal', 'custom', 'mixed'] as OrderType[]).map(t => {
                const meta = {
                  normal: { icon: '📦', label: 'Normal Order', sub: 'Standard-Bestellung / Sourcing' },
                  custom: { icon: '💎', label: 'Custom Order', sub: 'Goldsmith / Sonderanfertigung' },
                  mixed:  { icon: '🔀', label: 'Mixed Order', sub: 'Produkte + Goldsmith in einer Order' },
                }[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setOrderType(t)}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '12px 20px', fontSize: 14, fontWeight: 500, flex: 1,
                      border: `1px solid ${orderType === t ? '#0F0F10' : '#D5D9DE'}`,
                      color: orderType === t ? '#0F0F10' : '#6B7280',
                      background: orderType === t ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}
                  >
                    {meta.icon} {meta.label}
                    <div style={{ fontSize: 11, fontWeight: 400, color: '#9CA3AF', marginTop: 4 }}>
                      {meta.sub}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>

        {/* v0.2.1/v0.3.0 — Custom-Order conditional sections (custom ODER mixed) */}
        {(orderType === 'custom' || orderType === 'mixed') && (
          <>
            {/* v0.6.0 — Custom-Cards 3a-3d nur bei Bedarf öffnen (Quote-first) */}
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="text-overline">OPTIONALE DETAILS — BEI BEDARF ÖFFNEN</span>
              {([['3a', '3a · Customer Material'], ['3b', '3b · Goldsmith Labor'], ['3c', '3c · Extra Gold'], ['3d', '3d · Diamonds / Materials']] as const).map(([k, label]) => {
                const on = openCard[k];
                return (
                  <button key={k} type="button" onClick={() => setOpenCard(p => ({ ...p, [k]: !p[k] }))}
                    className="cursor-pointer rounded-full"
                    style={{ padding: '6px 14px', fontSize: 12,
                      border: `1px solid ${on ? '#0F0F10' : '#D5D9DE'}`,
                      color: on ? '#0F0F10' : '#6B7280',
                      background: on ? 'rgba(15,15,16,0.06)' : 'transparent' }}>
                    {on ? '− ' : '+ '}{label}
                  </button>
                );
              })}
            </div>

            {/* Customer Material Card */}
            {openCard['3a'] && (
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
            )}

            {/* Goldsmith Work Card */}
            {openCard['3b'] && (
            <div style={{ marginTop: 16 }}>
              <Card>
                <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3b · GOLDSMITH WORK / LABOR — COST (OPTIONAL)</span>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
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
                </div>
                <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                  Kosten sind optional — du kannst sie auch später auf der Order-Detail-Seite eintragen, sobald das Stück fertig ist.
                </p>
              </Card>
            </div>
            )}

            {/* Extra Gold Card */}
            {openCard['3c'] && (
            <div style={{ marginTop: 16 }}>
              <Card>
                <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3c · EXTRA GOLD (OPTIONAL)</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr', gap: 16 }}>
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
                    label="COST (BHD) — OPTIONAL"
                    type="number"
                    step="0.001"
                    placeholder="0.000"
                    value={extraGoldCost}
                    onChange={e => setExtraGoldCost(e.target.value)}
                  />
                </div>
                <div style={{ marginTop: 12 }}>
                  <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>GOLDSMITH / SUPPLIER (OPTIONAL)</span>
                  <SearchSelect
                    options={suppliers.filter(s => s.active).map(s => ({ id: s.id, label: s.name, subtitle: s.phone || '' }))}
                    value={extraGoldSupplierId}
                    onChange={setExtraGoldSupplierId}
                    placeholder="Goldschmied wählen = sein Gold → Gold-Verbindlichkeit · leer = eigenes Gold"
                  />
                </div>
                <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                  {extraGoldSupplierId
                    ? `Goldschmied-Gold → Gold-Verbindlichkeit (Gramm), später in Gold oder Geld beglichen. Cost optional${goldRate > 0 ? ` — leer = Bewertung zum Live-Goldpreis ${goldRate.toFixed(3)} BHD/g` : ''}.`
                    : 'Eigenes Gold → reine Geld-Kostenposition. Mit Goldschmied als Supplier wird stattdessen eine Gold-Verbindlichkeit angelegt.'}
                </p>
              </Card>
            </div>
            )}

            {/* Materials (Diamond/Stone/Gold-Piece) — uses shared component */}
            {openCard['3d'] && (
            <div style={{ marginTop: 16 }}>
              <MaterialsCard
                title="3d · DIAMONDS / STONES / GOLD-PIECES — COST (OPTIONAL)"
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
                onRemove={(rid) => setMaterialLines(prev => prev.filter(m => m._id !== rid))}
                showCustomerPrice={false}
                canEdit={true}
              />
            </div>
            )}

            {/* Final Product Description — immer offen (Quoted Price ist Pflicht) */}
            <div style={{ marginTop: 16 }}>
              <Card>
                <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>3e · FINAL PRODUCT / OUTPUT + QUOTED PRICE</span>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
                  <Input
                    label="FINAL PRODUCT DESCRIPTION"
                    placeholder="e.g. Custom 22K wedding ring with 0.5ct center diamond"
                    value={finalProductDescription}
                    onChange={e => setFinalProductDescription(e.target.value)}
                  />
                  <Input
                    label="QUOTED PRICE — APPROX. (BHD)"
                    type="number"
                    step="0.001"
                    placeholder="0.000"
                    value={quotedPrice}
                    onChange={e => setQuotedPrice(e.target.value)}
                  />
                </div>
                <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                  Der approx. Preis den der Kunde akzeptiert — landet auf dem Order-Beleg und später 1:1 auf der Invoice.
                </p>
              </Card>
            </div>
          </>
        )}

        {/* 2. ORDER ITEMS SECTION (Normal ODER Mixed) */}
        {(orderType === 'normal' || orderType === 'mixed') && <div style={{ marginTop: 16 }}>
          <Card>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span className="text-overline">{orderType === 'mixed' ? '4 · ORDER ITEMS (PRODUCTS)' : '3 · ORDER ITEMS'}</span>
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
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <select value={l.mode}
                        onChange={e => {
                          const m = e.target.value as 'existing' | 'new';
                          updateLine(idx, { mode: m, productId: undefined, newProduct: undefined, description: '' });
                          if (m === 'new') openNewItemModal(idx);
                        }}
                        style={{ padding: '6px 8px', fontSize: 11, border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF', width: '100%' }}>
                        <option value="existing">Existing Product</option>
                        <option value="new">New Product</option>
                      </select>
                      {l.mode === 'existing' ? (
                        <SearchSelect
                          placeholder="Pick product..."
                          options={productOptions}
                          value={l.productId || ''}
                          onChange={pid => pickProductForLine(idx, pid)}
                        />
                      ) : l.newProduct ? (
                        <div className="flex items-center justify-between" style={{
                          padding: '7px 10px', background: '#F2F7FA', border: '1px solid #E5E9EE',
                          borderRadius: 4, fontSize: 12, color: '#0F0F10', minWidth: 0,
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {l.newProduct.brand} <span style={{ color: '#4B5563' }}>{l.newProduct.name}</span>
                          </span>
                          <button onClick={() => openNewItemModal(idx)} title="Produkt-Details bearbeiten"
                            className="cursor-pointer flex items-center gap-1"
                            style={{ background: 'none', border: 'none', color: '#6B7280', padding: '0 0 0 8px', fontSize: 11 }}>
                            <Edit3 size={12} /> Edit
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => openNewItemModal(idx)}
                          className="cursor-pointer"
                          style={{
                            padding: '7px 10px', fontSize: 12, border: '1px dashed #D5D9DE',
                            borderRadius: 4, background: '#FFFFFF', color: '#6B7280', textAlign: 'left', width: '100%',
                          }}>
                          + Neues Produkt definieren…
                        </button>
                      )}
                      <input
                        placeholder="Description"
                        value={l.description}
                        onChange={e => updateLine(idx, { description: e.target.value })}
                        style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, minWidth: 0 }} />
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
        showCustomerPrice={false}
      />

      {/* Back-to-Back: New-Product-Zeile — volle Produkt-Spec via shared Modal */}
      <NewProductModal
        open={newItemModalIdx != null}
        onClose={() => setNewItemModalIdx(null)}
        onSubmit={handleModalSave}
        initial={modalInitial()}
        title="Neues Produkt — Artikel definieren"
        submitLabel="Artikel uebernehmen"
        hint={<>Das Produkt wird mit der Order angelegt. Einkaufspreis + Lagerbestand kommen spaeter beim Wareneingang (Purchase).</>}
        hideFields={{ purchasePrice: true, salePrice: true, paidFrom: true, supplier: true, quantity: true }}
      />
    </div>
  );
}
