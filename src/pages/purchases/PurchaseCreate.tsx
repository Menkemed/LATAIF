// Plan §Purchases — Full-Page New Purchase (wie Invoice/Order).
// Sections: Supplier / Items / Pricing / Initial Payment / Notes / Summary / Actions.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, X, Edit3, ChevronDown } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { validateCpr, validatePhone } from '@/core/contacts/contact-validate';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { DuplicateWarningBanner } from '@/components/contacts/DuplicateWarningBanner';
import { findSimilarContacts } from '@/core/contacts/duplicate-check';
import { NewProductModal } from '@/components/products/NewProductModal';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useProductStore } from '@/stores/productStore';
import { StaffSelect } from '@/components/employees/StaffSelect';
import type { Product, Supplier } from '@/core/models/types';
import { getProductSpecs, productSearchText } from '@/core/utils/product-format';
import { query } from '@/core/db/helpers';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
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
  // Back-to-Back: gesetzt fuer aus einer Order vorbefuellte Zeilen.
  sourceOrderLineId?: string;
}

export function PurchaseCreate() {
  const navigate = useNavigate();
  const goBack = useGoBack('/purchases');
  const [searchParams] = useSearchParams();
  const { createPurchase, markPurchaseInboxDone } = usePurchaseStore();
  const { suppliers, loadSuppliers, createSupplier } = useSupplierStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();

  useEffect(() => { loadSuppliers(); loadProducts(); loadCategories(); }, [loadSuppliers, loadProducts, loadCategories]);

  // v0.4.0 — Mit ?inbox=<id> aufgerufen (Klick auf ein Purchase-Inbox-Foto):
  // das Mobile-Capture-Foto in die erste "New Item"-Zeile laden und den
  // NewProductModal direkt oeffnen, damit der User AI-Identify nutzen kann.
  const inboxId = searchParams.get('inbox');
  const [inboxLoaded, setInboxLoaded] = useState(false);
  useEffect(() => {
    if (!inboxId || inboxLoaded || categories.length === 0) return;
    try {
      const rows = query('SELECT images, note FROM purchase_inbox WHERE id = ?', [inboxId]);
      if (rows.length > 0) {
        let imgs: string[] = [];
        try {
          const parsed = JSON.parse((rows[0].images as string) || '[]');
          if (Array.isArray(parsed)) imgs = parsed as string[];
        } catch { /* kein Bild */ }
        if (imgs.length > 0) {
          setLines(prev => {
            const next = [...prev];
            next[0] = {
              ...next[0],
              mode: 'new',
              newProduct: {
                categoryId: next[0].categoryId || categories[0]?.id || '',
                brand: '', name: '', sku: '', condition: '',
                taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD',
                attributes: {}, images: imgs,
              },
            };
            return next;
          });
          setNewItemModalIdx(0);
        }
        const note = rows[0].note as string | null;
        if (note) setNotes(prev => prev || note);
      }
    } catch { /* Inbox-Eintrag nicht gefunden → normale New Purchase */ }
    setInboxLoaded(true);
  }, [inboxId, inboxLoaded, categories]);

  // Back-to-Back: aus einer Order geoeffnet (Wareneingang erfassen) — die
  // angegebenen Order-Zeilen werden als Purchase-Zeilen vorbefuellt + verknuepft.
  const sourceOrderId = searchParams.get('sourceOrderId');
  const [sourceLoaded, setSourceLoaded] = useState(false);
  const [sourceOrderInfo, setSourceOrderInfo] = useState<{ orderNumber: string; customerName: string } | null>(null);
  useEffect(() => {
    if (!sourceOrderId || sourceLoaded || categories.length === 0 || products.length === 0) return;
    try {
      const ordRows = query(
        `SELECT o.order_number AS onum, c.first_name AS fn, c.last_name AS ln
           FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
          WHERE o.id = ?`,
        [sourceOrderId]
      );
      if (ordRows.length > 0) {
        setSourceOrderInfo({
          orderNumber: (ordRows[0].onum as string) || '',
          customerName: `${ordRows[0].fn || ''} ${ordRows[0].ln || ''}`.trim(),
        });
      }
      const wantIds = (searchParams.get('sourceOrderLineIds') || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (wantIds.length > 0) {
        const placeholders = wantIds.map(() => '?').join(',');
        const lineRows = query(
          `SELECT id, product_id, description, quantity FROM order_lines WHERE id IN (${placeholders})`,
          wantIds
        );
        const byId = new Map(lineRows.map(r => [r.id as string, r]));
        const seeded: DraftLine[] = [];
        for (const oid of wantIds) {
          const r = byId.get(oid);
          if (!r) continue;
          const pid = (r.product_id as string | null) || undefined;
          const p = pid ? products.find(pp => pp.id === pid) : undefined;
          seeded.push({
            mode: pid ? 'existing' : 'new',
            productId: pid,
            brand: p?.brand || '',
            name: p?.name || (r.description as string) || '',
            sku: p?.sku || '',
            categoryId: p?.categoryId || categories[0]?.id || '',
            quantity: Math.max(1, (r.quantity as number) || 1),
            unitPrice: 0,
            sourceOrderLineId: oid,
          });
        }
        if (seeded.length > 0) setLines(seeded);
      }
    } catch { /* Order/Migration nicht da → normales New Purchase */ }
    setSourceLoaded(true);
  }, [sourceOrderId, sourceLoaded, categories, products, searchParams]);

  const [supplierId, setSupplierId] = useState(searchParams.get('supplier') || '');
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0]);
  const [lines, setLines] = useState<DraftLine[]>([
    { mode: 'new', brand: '', name: '', sku: '', categoryId: categories[0]?.id || '', quantity: 1, unitPrice: 0 },
  ]);
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank' | 'benefit'>('bank');
  const [notes, setNotes] = useState('');
  const [staffId, setStaffId] = useState<string>('');
  const [error, setError] = useState('');
  // Plan §Purchase §Tax: Vorsteuer-Scheme für die ganze Purchase. Default ZERO
  // (Backward-Compat); bei VAT_10 wird vat_amount per Line dekomponiert.
  const [purchaseTaxScheme, setPurchaseTaxScheme] = useState<'ZERO' | 'VAT_10'>('ZERO');

  // Plan §Purchase §New-Item: Modal für volle Item-Erfassung (shared NewProductModal)
  const [newItemModalIdx, setNewItemModalIdx] = useState<number | null>(null);
  const [expandedLines, setExpandedLines] = useState<Record<number, boolean>>({});

  // Quick-Create Supplier inline (spart Navigation zu /suppliers + zurueck).
  // Felder spiegeln SupplierList — inkl. CPR + ID-Bild damit der Print-PDF
  // direkt mit dem Beleg-Block ausgedruckt werden kann.
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplierForm, setNewSupplierForm] = useState<Partial<Supplier>>({});

  // Duplicate-Check live im Quick-Modal (Salesforce-Stil): vermeidet
  // doppelt angelegte Suppliers wenn Counter-Mitarbeiter unter Druck schnell tippen.
  const supplierDuplicateMatches = useMemo(() => {
    if (!showNewSupplier) return [];
    return findSimilarContacts(
      { name: newSupplierForm.name, phone: newSupplierForm.phone },
      suppliers,
    );
  }, [showNewSupplier, newSupplierForm.name, newSupplierForm.phone, suppliers]);

  function handleCreateSupplier() {
    if (!newSupplierForm.name) return;
    const created = createSupplier(newSupplierForm);
    setSupplierId(created.id);
    setShowNewSupplier(false);
    setNewSupplierForm({});
  }

  function pickExistingSupplier(sid: string) {
    setSupplierId(sid);
    setShowNewSupplier(false);
    setNewSupplierForm({});
  }

  const supplier = useMemo(() => suppliers.find(s => s.id === supplierId), [suppliers, supplierId]);
  const supplierOptions = useMemo(() => suppliers.map(s => ({
    id: s.id,
    label: s.name,
    subtitle: s.phone || s.email,
  })), [suppliers]);
  const productOptions = useMemo(() =>
    products
      .filter(p => !(p.categoryId || '').startsWith('cat-repair-service'))
      .map(p => ({
        id: p.id,
        label: `${p.brand} ${p.name}`,
        subtitle: p.sku || undefined,
        meta: `${fmt(p.purchasePrice || 0)} BHD`,
        searchText: productSearchText(p),
      })),
    [products]);

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
    setNewItemModalIdx(idx);
  }

  function modalInitial(): Partial<Product> | undefined {
    if (newItemModalIdx == null) return undefined;
    const line = lines[newItemModalIdx];
    return line?.newProduct ?? {
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
  }

  function handleModalSave(prod: Partial<Product>) {
    if (newItemModalIdx == null) return;
    updateLine(newItemModalIdx, {
      newProduct: prod,
      brand: prod.brand || '',
      name: prod.name || '',
      sku: prod.sku || '',
      categoryId: prod.categoryId || '',
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
      ? { productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, taxScheme: purchaseTaxScheme, vatRate: inputVatRate, sourceOrderLineId: l.sourceOrderLineId }
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
          sourceOrderLineId: l.sourceOrderLineId,
        });

    const purchase = createPurchase({
      supplierId,
      purchaseDate,
      notes: notes || undefined,
      staffId: staffId || undefined,
      lines: payload,
      initialPayment: paymentAmount > 0 ? { amount: paymentAmount, method: paymentMethod } : undefined,
      sourceOrderId: sourceOrderId || undefined,
    });

    // v0.4.0 — Purchase aus einem Mobile-Inbox-Foto erstellt → Inbox-Item erledigt.
    if (inboxId) {
      try { markPurchaseInboxDone(inboxId); } catch { /* */ }
    }

    if (continueEditing) {
      reset();
    } else if (sourceOrderId) {
      // Back-to-Back: zurueck zur Order — die Posten stehen jetzt auf „Arrived".
      navigate(`/orders/${sourceOrderId}`);
    } else {
      navigate(`/purchases/${purchase.id}`);
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

        {/* Back-to-Back: Kontext-Banner wenn aus einer Order geoeffnet */}
        {sourceOrderId && sourceOrderInfo && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', background: '#F2F7FA',
            border: '1px solid #C6A36D', borderRadius: 8, fontSize: 13, color: '#0F0F10',
          }}>
            📦 Beschaffung fuer Order <strong>{sourceOrderInfo.orderNumber}</strong>
            {sourceOrderInfo.customerName ? ` · Kunde ${sourceOrderInfo.customerName}` : ''}
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
              Die vorbefuellten Posten werden mit der Order verknuepft und nach dem Speichern
              auf „Arrived" gesetzt. Du kannst weitere Lager-Posten ergaenzen.
            </div>
          </div>
        )}

        {/* 1. SUPPLIER */}
        <Card>
          <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>1 · SUPPLIER</span>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginTop: 12, alignItems: 'end' }}>
            <div>
              <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                <span className="text-overline">SUPPLIER</span>
                <button onClick={() => setShowNewSupplier(true)}
                  className="cursor-pointer flex items-center gap-1"
                  style={{
                    padding: '4px 10px', fontSize: 11, borderRadius: 999,
                    border: '1px solid #C6A36D', color: '#0F0F10',
                    background: 'rgba(198,163,109,0.08)',
                  }}>
                  <Plus size={12} /> New Supplier
                </button>
              </div>
              <SearchSelect
                placeholder="Search suppliers..."
                options={supplierOptions}
                value={supplierId}
                onChange={setSupplierId}
              />
            </div>
            <Input required label="PURCHASE DATE" type="date"
              value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} />
          </div>
          {supplier && (
            <div style={{ padding: '10px 14px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8, marginTop: 12, fontSize: 12, color: '#4B5563' }}>
              <div className="flex items-center justify-between">
                <div>
                  {supplier.name}{supplier.phone ? ` · ${supplier.phone}` : ''}{supplier.email ? ` · ${supplier.email}` : ''}
                  {supplier.cpr && (
                    <span style={{ marginLeft: 10, color: '#6B7280', fontSize: 11 }}>
                      CPR <span className="font-mono">{supplier.cpr}</span>
                    </span>
                  )}
                </div>
                {supplier.cprImage && (
                  <img src={supplier.cprImage} alt="CPR / ID Card"
                    style={{ maxWidth: 80, maxHeight: 50, border: '1px solid #E5E9EE', borderRadius: 4, objectFit: 'contain', background: '#FFFFFF' }} />
                )}
              </div>
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
                gridTemplateColumns: '28px 110px minmax(0,4fr) minmax(0,0.9fr) 60px minmax(0,1fr) minmax(0,1fr) 44px',
                gap: 10, padding: '10px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE',
                fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span></span>
                <span>Source</span>
                <span>Product</span>
                <span>SKU</span>
                <span>Qty</span>
                <span>Unit Price (BHD)</span>
                <span style={{ textAlign: 'right' }}>Line Total</span>
                <span></span>
              </div>
              {lines.map((l, idx) => {
                const lineProduct = l.mode === 'existing' && l.productId ? products.find(p => p.id === l.productId) : undefined;
                const lineSpecs = lineProduct ? getProductSpecs(lineProduct, categories) : [];
                const expanded = !!expandedLines[idx];
                return (
                <div key={idx} style={{ borderBottom: '1px solid #E5E9EE' }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '28px 110px minmax(0,4fr) minmax(0,0.9fr) 60px minmax(0,1fr) minmax(0,1fr) 44px',
                    gap: 10, padding: '10px 12px', alignItems: 'center',
                  }}>
                  {/* Chevron VOR Source — nur klickbar wenn Existing-Product mit Specs */}
                  {lineProduct && lineSpecs.length > 0 ? (
                    <button onClick={() => setExpandedLines(prev => ({ ...prev, [idx]: !prev[idx] }))}
                      title={expanded ? 'Details ausblenden' : 'Produkt-Details anzeigen'}
                      className="cursor-pointer"
                      style={{
                        width: 28, height: 28, borderRadius: 6,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: expanded ? 'rgba(126,91,239,0.1)' : 'transparent',
                        border: '1px solid ' + (expanded ? 'rgba(126,91,239,0.3)' : '#D5D9DE'),
                        color: expanded ? '#7E5BEF' : '#6B7280',
                        padding: 0,
                      }}>
                      <ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} />
                    </button>
                  ) : <span />}
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
                        renderPreview={id => {
                          const p = products.find(x => x.id === id);
                          return p ? <ProductHoverCard product={p} categories={categories} /> : null;
                        }}
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
                {/* Expanded Product-Detail-Panel — Specs-Grid + Image */}
                {expanded && lineProduct && (
                  <div style={{
                    padding: '14px 16px 16px',
                    background: '#FAFBFC',
                    borderTop: '1px solid #E5E9EE',
                    display: 'grid',
                    gridTemplateColumns: lineProduct.images?.length ? '100px 1fr' : '1fr',
                    gap: 18,
                    alignItems: 'start',
                  }}>
                    {lineProduct.images?.length ? (
                      <div style={{
                        width: 100, height: 100, borderRadius: 10,
                        background: '#FFFFFF', border: '1px solid #E5E9EE',
                        overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <img src={lineProduct.images[0]} alt={lineProduct.name}
                          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                      </div>
                    ) : null}
                    <div>
                      <div style={{ marginBottom: 8 }}>
                        <span style={{ fontSize: 11, color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Produkt-Specs</span>
                      </div>
                      <div style={{
                        display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                        columnGap: 18, rowGap: 8,
                      }}>
                        {lineSpecs.map((s, i) => (
                          <div key={i} style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 9, color: '#9CA3AF', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>{s.label}</div>
                            <div style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.value}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                </div>
                );
              })}
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
                  <Bhd v={subtotal}/> <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>INPUT VAT</span>
                <div className="font-display" style={{ fontSize: 20, color: inputVat > 0 ? '#AA956E' : '#6B7280' }}>
                  <Bhd v={inputVat}/> <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                </div>
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>TOTAL (PAID TO SUPPLIER)</span>
                <div className="font-display" style={{ fontSize: 24, color: '#C6A36D' }}>
                  <Bhd v={total}/> <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
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
                  {(['cash', 'bank', 'benefit'] as const).map(m => {
                    const active = paymentMethod === m;
                    return (
                      <button key={m} type="button" onClick={() => setPaymentMethod(m)}
                        className="cursor-pointer rounded"
                        style={{ padding: '8px 16px', fontSize: 13,
                          border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                          color: active ? '#0F0F10' : '#6B7280',
                          background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}</button>
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

        {/* Staff + Notes */}
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'minmax(0,0.7fr) minmax(0,1.3fr)', gap: 16 }}>
          <Card>
            <StaffSelect value={staffId} onChange={setStaffId} helper="Who handled this purchase (optional)." />
          </Card>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="z.B. Lieferscheinnummer, Zahlungsziel, interne Vermerke…"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, resize: 'vertical' }} />
          </Card>
        </div>

        {/* 5. SUMMARY — Premium Lila-Card im Dashboard-Spot-Look (Two-Tone-Glow) */}
        <div style={{
          position: 'relative', marginTop: 24, padding: '24px 28px', borderRadius: 20,
          background: 'linear-gradient(135deg, #5B3DCC 0%, #715DE3 50%, #8B7AE8 100%)',
          border: '1px solid rgba(255,255,255,0.10)', overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(91,61,204,0.25)', color: '#FFFFFF',
        }}>
          <div style={{ position: 'absolute', left: -80, bottom: -120, width: 320, height: 320, background: 'radial-gradient(circle, rgba(236,72,153,0.55) 0%, rgba(236,72,153,0) 70%)', filter: 'blur(20px)', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', right: -100, top: -100, width: 280, height: 280, background: 'radial-gradient(circle, rgba(115,217,237,0.35) 0%, rgba(115,217,237,0) 70%)', filter: 'blur(30px)', pointerEvents: 'none' }} />
          <div style={{ position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', letterSpacing: '0.10em', textTransform: 'uppercase', fontWeight: 600 }}>Summary</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>TOTAL</div>
                <div className="font-mono" style={{ fontSize: 18, color: '#FFFFFF' }}><Bhd v={total}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>PAID</div>
                <div className="font-mono" style={{ fontSize: 18, color: '#86E5A4' }}><Bhd v={paymentAmount}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>REMAINING</div>
                <div className="font-mono" style={{ fontSize: 18, color: remaining > 0 ? '#FFD27D' : '#86E5A4' }}><Bhd v={remaining}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>METHOD</div>
                <div style={{ fontSize: 18, color: '#FFFFFF', textTransform: 'capitalize' }}>{paymentMethod}</div>
              </div>
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

      {/* Plan §Purchase §New-Item: Shared NewProductModal — kein eigener Inline-Code mehr */}
      <NewProductModal
        open={newItemModalIdx != null}
        onClose={() => setNewItemModalIdx(null)}
        onSubmit={handleModalSave}
        initial={modalInitial()}
        title="New Item — Define Product"
        submitLabel="Use this Item"
        hint={<><strong style={{ color: '#0F0F10' }}>Wird ins Lager aufgenommen.</strong> Einkaufspreis kommt aus der Purchase-Line — nicht doppelt eingeben.</>}
        hideFields={{ purchasePrice: true, salePrice: true, paidFrom: true, supplier: true, quantity: true }}
      />

      {/* Quick-Create Supplier — gleiche Felder wie SupplierList, inkl. CPR + ID-Card. */}
      <Modal open={showNewSupplier} onClose={() => setShowNewSupplier(false)} title="New Supplier" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {supplierDuplicateMatches.length > 0 && (
            <DuplicateWarningBanner
              matches={supplierDuplicateMatches}
              entityLabel="supplier"
              onSelectMatch={s => pickExistingSupplier(s.id)}
            />
          )}
          <Input required label="NAME" placeholder="e.g. Gold Dealer LLC"
            value={newSupplierForm.name || ''} onChange={e => setNewSupplierForm({ ...newSupplierForm, name: e.target.value })}
            autoFocus />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <PhoneInput label="PHONE" value={newSupplierForm.phone || ''}
                onChange={v => setNewSupplierForm({ ...newSupplierForm, phone: v })} />
              <SoftWarn warning={validatePhone(newSupplierForm.phone).warning} />
            </div>
            <Input label="EMAIL" placeholder="contact@supplier.com"
              value={newSupplierForm.email || ''}
              onChange={e => setNewSupplierForm({ ...newSupplierForm, email: e.target.value })} />
          </div>
          <Input label="ADDRESS" placeholder="Street, City"
            value={newSupplierForm.address || ''}
            onChange={e => setNewSupplierForm({ ...newSupplierForm, address: e.target.value })} />
          <div>
            <Input label="CPR / ID NUMBER" placeholder="e.g. 900123456"
              value={newSupplierForm.cpr || ''}
              onChange={e => setNewSupplierForm({ ...newSupplierForm, cpr: e.target.value })} />
            <SoftWarn warning={validateCpr(newSupplierForm.cpr).warning} />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CPR / ID CARD PHOTO</span>
            <p style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 6 }}>Wird auf jedem Ankaufs-Print mitgedruckt.</p>
            <ImageUpload
              images={newSupplierForm.cprImage ? [newSupplierForm.cprImage] : []}
              onChange={imgs => setNewSupplierForm({ ...newSupplierForm, cprImage: imgs[0] || undefined })}
              maxImages={1}
            />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
            <textarea
              value={newSupplierForm.notes || ''}
              onChange={e => setNewSupplierForm({ ...newSupplierForm, notes: e.target.value })}
              className="w-full outline-none"
              rows={2}
              style={{ marginTop: 6, background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical' }}
            />
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setShowNewSupplier(false); setNewSupplierForm({}); }}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateSupplier} disabled={!newSupplierForm.name}>
              {supplierDuplicateMatches.length > 0 ? 'Create anyway &amp; Use' : 'Create &amp; Use'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
