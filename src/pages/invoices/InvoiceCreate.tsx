// Plan §Sales — Full-Page Invoice Create + Edit (User-Spec).
// Sections: Customer / Products / Tax / Pricing / Payment / Invoice Type / Summary / Actions.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save, Printer, X, Phone, ChevronDown } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useOrderStore } from '@/stores/orderStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { vatEngine } from '@/core/tax/vat-engine';
import { getLotsWithPurchaseNumbers, formatLotLabel, getStockAggregates, type StockLot } from '@/core/lots/lot-queries';
import { Bhd } from '@/components/ui/Bhd';
import { getProductSpecs, productSearchText } from '@/core/utils/product-format';

type Scheme = 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN';
type Method = 'cash' | 'bank_transfer' | 'card' | 'benefit';

interface DraftLine {
  productId: string;
  scheme: Scheme;
  quantity: number;
  unitPrice: number; // Netto pro Stück
  lotId?: string;    // Phase 3 — explizite Lot-Auswahl pro Line; auto bei Pick.
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
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
  const goBack = useGoBack('/invoices');
  const [searchParams] = useSearchParams();
  const { id: editId } = useParams<{ id: string }>();
  const isEditMode = !!editId;
  const { invoices, loadInvoices, createDirectInvoice, recordPayment, editInvoice: editInvoiceFn, getInvoicePayments } = useInvoiceStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  // v0.6.9 — Soft-Reservation: Map product_id → { qty, orderNumbers[] } fuer den Picker-Hinweis.
  const { orders, loadOrders, getAllProductReservations } = useOrderStore();
  const { employees, loadEmployees } = useEmployeeStore();
  const activeEmployees = useMemo(() => employees.filter(e => e.employmentStatus !== 'inactive'), [employees]);

  useEffect(() => { loadCustomers(); loadProducts(); loadCategories(); loadEmployees(); loadOrders(); if (isEditMode) loadInvoices(); }, [loadCustomers, loadProducts, loadCategories, loadEmployees, loadOrders, loadInvoices, isEditMode]);

  const editInvoice = useMemo(() => isEditMode ? invoices.find(i => i.id === editId) : undefined, [isEditMode, editId, invoices]);

  const [customerId, setCustomerId] = useState(searchParams.get('customer') || '');
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [issuedDate, setIssuedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [lines, setLines] = useState<DraftLine[]>([
    { productId: '', scheme: 'auto', quantity: 1, unitPrice: 0 },
  ]);
  // Local string state per line for editable Total — preserves trailing zeros while typing.
  const [lineTotalDrafts, setLineTotalDrafts] = useState<Record<number, string>>({});
  const [expandedLines, setExpandedLines] = useState<Record<number, boolean>>({});
  const [paymentMethod, setPaymentMethod] = useState<Method>('cash');
  // v0.7.26 — Karten-Brand (nur relevant wenn method === 'card'); steuert die Gebuehr (2,2% vs 2,5%).
  const [cardBrand, setCardBrand] = useState<'normal' | 'amex'>('normal');
  const [paidAmount, setPaidAmount] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [staffId, setStaffId] = useState<string>('');
  const [editReason, setEditReason] = useState('');  // Pflicht-Grund im Edit-Modus (Audit)
  const [error, setError] = useState('');
  const [hydrated, setHydrated] = useState(!isEditMode);
  // 2026-05-16 — Number-Type-Dialog: erscheint wenn die Rechnung als FINAL gespeichert wird.
  const [numberDialog, setNumberDialog] = useState<{ thenPrint: boolean } | null>(null);
  const [originalPaid, setOriginalPaid] = useState<number>(0);

  // Edit-Modus: einmalig Invoice + Lines + Payments in Form laden.
  useEffect(() => {
    if (!isEditMode || !editInvoice || hydrated) return;
    setCustomerId(editInvoice.customerId);
    setNotes(editInvoice.notes || '');
    setStaffId(editInvoice.staffId || '');
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
      if (m === 'cash' || m === 'bank_transfer' || m === 'card' || m === 'benefit') setPaymentMethod(m);
    }
    setHydrated(true);
  }, [isEditMode, editInvoice, hydrated, products, getInvoicePayments]);

  const customer = useMemo(() => customers.find(c => c.id === customerId), [customers, customerId]);
  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`,
    subtitle: c.phone,
  })), [customers]);
  // v0.6.9 — Reservierungen vorberechnen (Soft-Warnung im Picker).
  const productReservations = useMemo(() => getAllProductReservations(), [orders, getAllProductReservations]);

  const productOptions = useMemo(() => {
    // Plan §Sales §Partial-Payment-Reservation: 'reserved' / 'consignment_reserved'
    // = schon auf einer PARTIAL-Invoice, darf nicht ein zweites Mal verkauft werden.
    // 'sold' analog.
    const visible = products.filter(p =>
      p.stockStatus !== 'sold' &&
      p.stockStatus !== 'reserved' &&
      p.stockStatus !== 'consignment_reserved' &&
      // with_agent = physisch beim Agenten, nicht im Laden → nicht direkt
      // verkaufbar (sonst Doppel-Verplanung). Erst Agent-Return → in_stock.
      p.stockStatus !== 'with_agent'
    );
    // Phase 7: "stock N" zeigt Lot-Total (echte verfuegbare Stuecke) statt
    // legacy product.quantity. Eine Query fuer alle Produkte (Bulk).
    const agg = getStockAggregates(visible.map(p => p.id));
    return visible.map(p => {
      const stock = agg.get(p.id)?.totalQty ?? (p.quantity || 1);
      // v0.6.9 — Soft-Reservation: zeige im Picker an, wenn dieses Stueck in einer
      // offenen Order versprochen ist. Nicht blockierend — der User entscheidet.
      const res = productReservations.get(p.id);
      const resHint = res && res.qty > 0
        ? ` · 🔒 ${res.qty} reserviert (${res.orderNumbers.slice(0, 2).join(', ')}${res.orderNumbers.length > 2 ? '…' : ''})`
        : '';
      return {
        id: p.id,
        label: `${p.brand} ${p.name}`,
        subtitle: `${fmt(p.plannedSalePrice ?? p.purchasePrice ?? 0)} BHD · stock ${stock}${resHint}`,
        meta: p.sku,
        searchText: productSearchText(p),
      };
    });
  }, [products, productReservations]);

  // Pro Zeile: aufgelöstes Scheme + Berechnung (Memo via direkter map)
  // Phase 3 — Cost-Snapshot kommt aus dem ausgewaehlten Lot statt aus
  // products.purchase_price. Wenn kein Lot existiert (Legacy-Produkte vor
  // Backfill / direkt erstellt) faellt es auf product.purchasePrice zurueck.
  const computed = lines.map(l => {
    const product = products.find(p => p.id === l.productId);
    if (!product) {
      return { product: undefined, lots: [] as Array<StockLot & { purchaseNumber: string | null }>,
        selectedLot: null as (StockLot & { purchaseNumber: string | null }) | null,
        scheme: 'VAT_10' as const, vatRate: 10, net: 0, vat: 0, internalVat: 0, gross: 0 };
    }
    const lots = getLotsWithPurchaseNumbers(product.id);
    const selectedLot = lots.find(lot => lot.id === l.lotId) || lots[0] || null;
    const costBasis = selectedLot ? selectedLot.unitCost : (product.purchasePrice || 0);
    const resolved = (l.scheme === 'auto' ? (product.taxScheme as 'VAT_10' | 'ZERO' | 'MARGIN') : l.scheme);
    const vatRate = resolved === 'ZERO' ? 0 : 10;
    const calc = calcLine(l.unitPrice, l.quantity, costBasis, resolved, vatRate);
    return {
      product, lots, selectedLot, scheme: resolved, vatRate,
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
    // Phase 3 — beim Produktwechsel direkt aeltesten Lot auto-picken (FIFO),
    // damit der Cost-Snapshot deterministisch ist und User nicht extra klicken muss.
    const lots = getLotsWithPurchaseNumbers(productId);
    updateLine(idx, {
      productId,
      lotId: lots[0]?.id,
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
    // Überzahlung: Im EDIT-Modus erlaubt — editInvoice (S3b) verbucht den Überschuss
    // (Reduktion des Totals unter den bereits bezahlten Betrag ODER Delta-Überzahlung)
    // atomar als Customer Credit. Im CREATE-Modus (Direktverkauf) bleibt der Guard ein
    // Tippfehler-Schutz; S3a-Überzahlung läuft bewusst über den Payment-Flow am
    // Invoice-Detail (InvoiceDetail.handleRecordPayment hat dort keinen Guard).
    if (!isEditMode && paidAmount > total) return `Paid (${fmt(paidAmount)}) exceeds total (${fmt(total)})`;
    return null;
  }

  function handleSave(thenPrint: boolean) {
    setError('');
    const v = validate();
    if (v) { setError(v); return; }

    // Wird die Rechnung mit diesem Save final?
    //   Create:  paidAmount >= total
    //   Edit:    bisher nicht final + neues paid >= total
    const goingFinal = total > 0 && paidAmount >= total - 0.005 && (
      !isEditMode || (editInvoice && editInvoice.status !== 'FINAL')
    );
    if (goingFinal) {
      setNumberDialog({ thenPrint });
      return;
    }
    performSave(thenPrint, false);
  }

  function performSave(thenPrint: boolean, specialMark: boolean) {
    const payload = lines.map((l, i) => {
      const c = computed[i];
      // Phase 3 — Cost-Snapshot kommt vom ausgewaehlten Lot, NICHT mehr vom
      // (potentiell veralteten) products.purchase_price. Fallback fuer Legacy-
      // Produkte ohne Lot bleibt das Produkt-Feld.
      const costSnapshot = c.selectedLot ? c.selectedLot.unitCost : (c.product?.purchasePrice || 0);
      return {
        productId: l.productId,
        lotId: c.selectedLot?.id,
        quantity: Math.max(1, l.quantity),
        unitPrice: c.net / Math.max(1, l.quantity), // Netto pro Stück (für Detail-View)
        purchasePrice: costSnapshot,
        taxScheme: c.scheme,
        vatRate: c.vatRate,
        // v0.7.1 — NBR: MARGIN persistiert internalVat (= margin × rate/(100+rate))
        // damit MARGIN_VAT-Ledger + invoice.vatAmount-Hero korrekt. Customer-Receipt
        // versteckt VAT bei MARGIN weiterhin (Differenzbesteuerung).
        vatAmount: c.internalVat || c.vat,
        lineTotal: c.gross,
      };
    });

    if (isEditMode && editInvoice) {
      // Edit-Modus: ALLES (Header + Zeilen + Inventory + Ledger-Reverse+Repost +
      // optionale Delta-Zahlung + Status + Audit) atomar in editInvoice — eine
      // einzige SQL-Transaktion im Store, nicht mehr UI-orchestriert.
      const issuedIso = `${issuedDate}T00:00:00.000Z`;
      const reason = editReason.trim();
      if (!reason) { setError('Please enter a reason for this edit.'); return; }
      // Delta-Zahlung nur bei Erhoehung des bezahlten Betrags (Reduktion ignoriert —
      // negatives Payment gibt es im Modell nicht). Reduktion unter paid blockiert der Store.
      const delta = paidAmount - originalPaid;
      const deltaPayment = delta > 0.001
        ? { amount: delta, method: paymentMethod, cardBrand: paymentMethod === 'card' ? cardBrand : undefined }
        : undefined;
      try {
        editInvoiceFn(editInvoice.id, {
          lines: payload,
          customerId,
          notes: notes || undefined,
          issuedAt: issuedIso,
          staffId: staffId || undefined,
          deltaPayment,
          reason,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (thenPrint) {
        navigate(`/invoices/${editInvoice.id}?print=1`);
      } else {
        navigate(`/invoices/${editInvoice.id}`);
      }
      return;
    }

    const inv = createDirectInvoice(customerId, payload, notes || undefined, issuedDate, undefined, staffId || undefined, specialMark);
    if (!inv) { setError('Failed to create invoice'); return; }

    if (paidAmount > 0) {
      recordPayment(inv.id, paidAmount, paymentMethod, undefined, specialMark, paymentMethod === 'card' ? cardBrand : undefined);
    }

    if (thenPrint) {
      navigate(`/invoices/${inv.id}?print=1`);
    } else {
      navigate(`/invoices/${inv.id}`);
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
            <h1 className="font-display" style={{ fontSize: 30, color: '#0F0F10', lineHeight: 1.2 }}>
              {isEditMode ? `Edit Invoice ${editInvoice ? formatInvoiceDisplayShort(editInvoice) : ''}` : 'Direct Sale'}
            </h1>
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
              {isEditMode ? 'All fields editable — Save overwrites the invoice.' : 'Customer, products, tax, payment — all on one page.'}
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
                gridTemplateColumns: '28px minmax(0,4fr) minmax(0,0.9fr) minmax(0,1fr) 56px minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.1fr) 44px',
                gap: 10, padding: '10px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE',
                fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span></span>
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
                const lineSpecs = c.product ? getProductSpecs(c.product, categories) : [];
                const expanded = !!expandedLines[idx];
                return (
                <div key={idx} style={{ borderBottom: '1px solid #E5E9EE' }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '28px minmax(0,4fr) minmax(0,0.9fr) minmax(0,1fr) 56px minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.1fr) 44px',
                    gap: 10, padding: '10px 12px', alignItems: 'center',
                  }}>
                    {/* Chevron VOR dem Produkt — nur klickbar wenn Produkt gewaehlt und Specs vorhanden */}
                    {c.product && lineSpecs.length > 0 ? (
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
                    <div style={{ minWidth: 0 }}>
                      <SearchSelect
                        placeholder="Pick product..."
                        options={productOptions}
                        value={l.productId}
                        onChange={pid => pickProductForLine(idx, pid)}
                        renderPreview={id => {
                          const p = products.find(x => x.id === id);
                          return p ? <ProductHoverCard product={p} categories={categories} /> : null;
                        }}
                      />
                      {/* Phase 3 — Lot-Picker wenn mehrere ACTIVE Lots fuer das Produkt
                          existieren. Single-Lot bleibt unsichtbar (UX wie bisher). */}
                      {c.lots.length > 1 && (
                        <select
                          value={l.lotId || c.selectedLot?.id || ''}
                          onChange={e => updateLine(idx, { lotId: e.target.value })}
                          title="Pick which stock lot (charge) is being sold"
                          style={{
                            marginTop: 6, padding: '5px 7px', fontSize: 11,
                            border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF',
                            width: '100%', color: '#4B5563',
                          }}
                        >
                          {c.lots.map(lot => (
                            <option key={lot.id} value={lot.id}>
                              {formatLotLabel(lot, lot.purchaseNumber || undefined)}
                            </option>
                          ))}
                        </select>
                      )}
                      {c.lots.length === 1 && c.selectedLot && (
                        <div style={{ marginTop: 4, fontSize: 10, color: '#9CA3AF' }}>
                          Lot · {c.selectedLot.unitCost.toLocaleString('en-US', { maximumFractionDigits: 0 })} BHD cost
                        </div>
                      )}
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
                  {/* Expanded Product-Detail-Panel — Specs-Grid + Image */}
                  {expanded && c.product && (
                    <div style={{
                      padding: '14px 16px 16px',
                      background: '#FAFBFC',
                      borderTop: '1px solid #E5E9EE',
                      display: 'grid',
                      gridTemplateColumns: c.product.images?.length ? '100px 1fr' : '1fr',
                      gap: 18,
                      alignItems: 'start',
                    }}>
                      {c.product.images?.length ? (
                        <div style={{
                          width: 100, height: 100, borderRadius: 10,
                          background: '#FFFFFF', border: '1px solid #E5E9EE',
                          overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <img src={c.product.images[0]} alt={c.product.name}
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
                        {c.scheme === 'MARGIN' && (
                          <div style={{ marginTop: 10, fontSize: 10, color: '#AA956E' }}>
                            Tax scheme "Margin Scheme" applied: VAT 0% on margin.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
              Tax scheme "Auto" follows the product default. Manual: VAT 10% / Zero / Margin per line.
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
                    { id: 'benefit', label: 'Benefit' },
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
                {/* v0.7.26 — Karten-Brand: Normal (Visa/MC/Debit) 2,2% vs Amex 2,5%. */}
                {paymentMethod === 'card' && (
                  <div className="flex gap-2" style={{ marginTop: 10 }}>
                    {([
                      { id: 'normal', label: 'Normal' },
                      { id: 'amex', label: 'Amex' },
                    ] as const).map(b => {
                      const on = cardBrand === b.id;
                      return (
                        <button key={b.id} type="button" onClick={() => setCardBrand(b.id)}
                          className="cursor-pointer rounded"
                          style={{ padding: '6px 14px', fontSize: 12,
                            border: `1px solid ${on ? '#0F0F10' : '#D5D9DE'}`,
                            color: on ? '#0F0F10' : '#6B7280',
                            background: on ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}>{b.label}</button>
                      );
                    })}
                  </div>
                )}
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
                Paid so far: <strong><Bhd v={originalPaid}/> BHD</strong>. If you raise the amount, the difference is booked as a new payment. Existing payments are not overwritten — for detailed payment management use the detail page. If the new total is below the paid amount, the difference becomes customer credit.
              </div>
            )}
            {isEditMode && paidAmount > total + 0.005 && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.35)', borderRadius: 6, fontSize: 12, color: '#B45309' }}>
                The paid amount exceeds the new total. The difference (<strong><Bhd v={paidAmount - total}/> BHD</strong>) will be converted into customer credit.
              </div>
            )}
            {isEditMode && (
              <div style={{ marginTop: 12 }}>
                <span className="text-overline" style={{ marginBottom: 4, display: 'block' }}>EDIT REASON *</span>
                <input value={editReason}
                  onChange={e => setEditReason(e.target.value)}
                  placeholder="Why is this invoice being edited? (required — saved to the audit log)"
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF', color: '#0F0F10' }} />
              </div>
            )}
            <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                <span className="text-overline">PAID</span>
                <div className="font-mono" style={{ fontSize: 17, color: '#7EAA6E', marginTop: 4 }}>
                  <Bhd v={paidAmount}/> BHD
                </div>
              </div>
              <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                <span className="text-overline">REMAINING</span>
                <div className="font-mono" style={{ fontSize: 17, color: remaining > 0 ? '#AA956E' : '#7EAA6E', marginTop: 4 }}>
                  <Bhd v={remaining}/> BHD
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
                Set automatically: fully paid → INV, otherwise PINV. On later full payment the system promotes PINV → INV.
              </span>
            </div>
          </Card>
        </div>

        {/* Staff + Notes */}
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'minmax(0,0.7fr) minmax(0,1.3fr)', gap: 16 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>STAFF</span>
            {activeEmployees.length === 0 ? (
              <span style={{ fontSize: 12, color: '#6B7280' }}>
                No employees yet. <a href="/employees" style={{ color: '#3D7FFF' }}>Add one</a> to track who closed this sale.
              </span>
            ) : (
              <select
                value={staffId}
                onChange={e => setStaffId(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 13,
                  border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF', color: '#0F0F10',
                }}
              >
                <option value="">— Unassigned —</option>
                {activeEmployees.map(emp => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}{emp.role ? ` · ${emp.role}` : ''}
                  </option>
                ))}
              </select>
            )}
            <span style={{ display: 'block', marginTop: 6, fontSize: 11, color: '#6B7280' }}>
              Who closed this sale (optional).
            </span>
          </Card>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="e.g. delivery details, special requests…"
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, resize: 'vertical' }} />
          </Card>
        </div>

        {/* 7. SUMMARY BOX — Premium Lila-Card im Dashboard-Spot-Look (Two-Tone-Glow) */}
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>SUBTOTAL</div>
                <div className="font-mono" style={{ fontSize: 16, color: '#FFFFFF' }}><Bhd v={subtotal}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>VAT</div>
                <div className="font-mono" style={{ fontSize: 16, color: '#FFD27D' }}><Bhd v={totalVat}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>TOTAL</div>
                <div className="font-mono" style={{ fontSize: 18, color: '#FFFFFF' }}><Bhd v={total}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>PAID</div>
                <div className="font-mono" style={{ fontSize: 16, color: '#86E5A4' }}><Bhd v={paidAmount}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>REMAINING</div>
                <div className="font-mono" style={{ fontSize: 16, color: remaining > 0 ? '#FFD27D' : '#86E5A4' }}><Bhd v={remaining}/> BHD</div>
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

      <NumberTypeDialog
        open={!!numberDialog}
        variant="sales"
        onCancel={() => setNumberDialog(null)}
        onConfirm={(special) => {
          const ctx = numberDialog;
          setNumberDialog(null);
          if (ctx) performSave(ctx.thenPrint, special);
        }}
      />
    </div>
  );
}
