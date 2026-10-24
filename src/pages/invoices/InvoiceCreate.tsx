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
import { CollectionProductThumb } from '@/components/products/CollectionProductThumb';
import { useMediaScope } from '@/hooks/useMediaScope';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useOrderStore } from '@/stores/orderStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { calcInvoiceLine, toInvoiceLine } from '@/core/invoices/line-derivation';
import { formatLotLabel, type StockLot } from '@/core/lots/lot-queries';
import { Bhd } from '@/components/ui/Bhd';
import { getProductSpecs, productSearchText } from '@/core/utils/product-format';
import { checkEditReason, EDIT_REASON_REQUIRED_MESSAGE } from '@/core/invoices/edit-reason';
import { keptLineLotShortMessage } from '@/core/invoices/edit-lines';
import { useSharedRead } from '@/core/data/shared-read';
import { useSharedWrite, fehlertext, nichtAmClient } from '@/core/data/shared-write';
import { lotAggregatesFor, productLotsBatchFor, LEERE_LOSE } from '@/core/data/domain-reads';
import { createInvoiceOnPrimary, invoiceCreatePaymentsBody, MAX_CREATE_PAYMENTS, type InvoiceCreatePayment } from '@/core/invoices/invoice-create-house';
// v0.8.87 — Kartenarten (Normal / Amex / Debit) und die Datumsregel aus je EINER Quelle.
import { CARD_BRAND_OPTIONS, cardFeeConfigured, computeCardFee, type CardBrand } from '@/core/finance/card-fees';

const DEBIT_FEE_MISSING = 'Debit card fee is not set yet. Enter it in Settings → Tax / VAT → Card Processing Fee (0 % is allowed).';
import { businessDateIssue, latestBusinessDate } from '@/core/utils/business-date';
import { currentBranchId } from '@/core/db/helpers';
import { productDisplayName } from '@/core/products/display-name';
// BULK METAL V1 — Bulk-Zeile: Absicht (Lot, Gewicht, Typ, Preis); Zeile rechnet das Haus mit dem Zeilenvertrag.
import { BulkInvoiceLineRow, previewBulkCogs, type BulkInvoiceDraft } from '@/components/bulk/BulkInvoiceLineRow';
import { bulkLotsForSaleFor, type BulkLotForSale } from '@/core/bulk/bulk-reads';
import { formatMg, netFilsFromGross, parseBhdToFils, parseGramsToMg, type BulkType } from '@/core/bulk/bulk-math';

type Scheme = 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN';
type Method = 'cash' | 'bank_transfer' | 'card' | 'benefit';

/** v0.8.87 — eine Zahlungszeile beim Anlegen: Weg, Kartenart, Betrag (Text, wie getippt), Tag. */
interface PayRow {
  key: number;
  method: Method;
  cardBrand: CardBrand;
  amountText: string;
  date: string;
  /** Der Mensch hat den Tag selbst gewählt — dann folgt er dem Rechnungsdatum nicht mehr. */
  dateTouched: boolean;
}
const payAmountOf = (r: PayRow): number => { const v = parseFloat(r.amountText); return Number.isFinite(v) ? v : 0; };

interface DraftLine {
  /** INVOICE-EDIT S2 — beim Ändern: die gespeicherte Rechnungszeile, die diese Zeile fortsetzt. */
  lineId?: string;
  productId: string;
  scheme: Scheme;
  quantity: number;
  unitPrice: number; // Netto pro Stück
  lotId?: string;    // Phase 3 — explizite Lot-Auswahl pro Line; auto bei Pick.
  /** INVOICE-EDIT S2 — was die gespeicherte Zeile hält: Artikel, Los, Einstand, Menge. Solange der
   *  Artikel bleibt, bleibt die Zeile auf diesem Los (kein Loswechsel beim Ändern). */
  kept?: { productId: string; lotId: string | null; cost: number; qty: number };
  /** BULK METAL V1 — eine Bulk-Zeile (Menge fest 1). */
  bulk?: BulkInvoiceDraft;
}

/** BULK METAL V1 — Gewicht und Preis einer Bulk-Zeile exakt in mg/Fils (Text → Integer). */
function bulkIntentOf(b: BulkInvoiceDraft, scheme: string) {
  const weightMg = b.kept ? b.kept.weightMg : parseGramsToMg(b.weightText.trim());
  const grossFils = parseBhdToFils(b.grossText.trim(), true);
  return {
    lotId: b.lotId, weightMg, bulkType: b.bulkType, unitPriceFils: netFilsFromGross(grossFils, scheme),
    ...(b.description.trim() ? { description: b.description.trim() } : {}),
  };
}

/** INVOICE-EDIT S2 — die Zeile setzt eine gespeicherte fort (gleicher Artikel) → ihr Los steht fest. */
function keptOf(l: DraftLine): DraftLine['kept'] | null {
  return l.lineId && l.kept && l.kept.productId === l.productId ? l.kept : null;
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

// CENTRAL-C3B — die Ableitung liegt jetzt in der SSOT (`core/invoices/line-derivation`), damit
// der Fernauftrag GENAU dieselbe benutzt. Hier bleibt nur der Name, den die Anzeige schon ruft.
const calcLine = calcInvoiceLine;

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
  const { invoices, loadInvoices, editInvoice: editInvoiceFn, getInvoicePayments } = useInvoiceStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const { tenantId: mediaTenantId, branchId: mediaBranchId } = useMediaScope();
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
  const [cardBrand, setCardBrand] = useState<'normal' | 'amex' | 'debit'>('normal');
  const [paidAmount, setPaidAmount] = useState<number>(0);
  // v0.8.87 — beim ANLEGEN mehrere Zahlungen (je Weg, Kartenart, Betrag, Tag); das Ändern behält die eine Delta-Zahlung oben.
  const [payRows, setPayRows] = useState<PayRow[]>(() => [{ key: 1, method: 'cash', cardBrand: 'normal', amountText: '', date: new Date().toISOString().split('T')[0], dateTouched: false }]);
  const [payRowSeq, setPayRowSeq] = useState(2);
  // CENTRAL-UI-PARITY R4B — dieselbe Maske, zwei Anschluesse hinter dem Speichern.
  const anlegen = useSharedWrite<{ invoiceId: string }>('invoices.create');
  // CENTRAL-UI-PARITY R6B — das Ändern dieser Seite geht fern über die vorhandene Buchung.
  const aendernRechnung = useSharedWrite<Record<string, unknown>>('invoices.update');
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
    // INVOICE-EDIT S2 — die ID der gespeicherten Zeile reist mit, damit der Speichern-Vorgang
    // nicht raten muss, welche Zeile fortgesetzt wird (zwei gleiche Artikel, einer retourniert).
    const invLines = (editInvoice.lines || []).map(l => {
      if (l.bulkWeightMg) {
        const bulk: BulkInvoiceDraft = {
          lotId: l.lotId || '', weightText: formatMg(l.bulkWeightMg), bulkType: (l.bulkType || 'OTHER') as BulkType,
          grossText: (l.lineTotal || 0).toFixed(3), description: l.description || '',
          kept: { weightMg: l.bulkWeightMg, cogsFils: l.bulkCogsFils ?? 0, lotLabel: l.bulkLotNo || '—', scheme: String(l.taxScheme) },
        };
        return { lineId: l.id, productId: l.productId || '', scheme: 'auto' as Scheme, quantity: 1, unitPrice: l.unitPrice || 0, bulk };
      }
      const p = products.find(pp => pp.id === l.productId);
      const stored = (l.taxScheme as Scheme | undefined);
      const matchesProduct = stored && p && stored === p.taxScheme;
      const qty = l.quantity || 1;
      const unitNet = qty > 0 ? (l.unitPrice || 0) : 0;
      return {
        lineId: l.id,
        kept: { productId: l.productId || '', lotId: l.lotId ?? null, cost: l.purchasePriceSnapshot || 0, qty },
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
  // CENTRAL-UI-PARITY R4A — Losezahlen aus der gemeinsamen Kernauskunft statt einer eigenen
  // Abfrage: auf einem Rechner ohne Datenbank warf die sonst mitten im Zeichnen.
  const bestand = useSharedRead('inventory.lot_aggregates.get', {}, lotAggregatesFor, { paare: [], fifo: [] }, []);
  const lotAgg = useMemo(() => new Map(bestand.paare), [bestand]);
  // CENTRAL-UI-PARITY R4A.1 — die Lose der gewaehlten Artikel. Bis hier holte sie jede Zeile im
  // Zeichnen selbst aus der Datenbank; auf einem Rechner ohne Datenbank warf genau das, sobald
  // der Mensch einen Artikel gewaehlt hatte. Jetzt eine Frage fuer alle Zeilen, ueber denselben
  // Weg wie der Rest der Seite.
  const zeilenArtikel = useMemo(
    () => [...new Set(lines.map(l => l.productId).filter(Boolean))].sort(),
    [lines],
  );
  const loseAntwort = useSharedRead(
    'product.lots.batch.get',
    { productIds: zeilenArtikel },
    (ctx) => productLotsBatchFor(ctx, zeilenArtikel),
    { byProduct: [] as Array<[string, typeof LEERE_LOSE]> },
    [],
  );
  const loseJeArtikel = useMemo(() => new Map(loseAntwort.byProduct), [loseAntwort]);

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
      p.stockStatus !== 'with_agent' &&
      // CONSIGNMENT-INTEGRITY F7 — Kommissionsware verkauft nur „Record Sale“ auf der Kommission
      // (Einlieferer-Verbindlichkeit, Provision, Verknüpfung). Das Haus weist sie hier ohnehin ab.
      p.sourceType !== 'CONSIGNMENT' && p.stockStatus !== 'consignment'
    );
    // Phase 7: "stock N" zeigt Lot-Total (echte verfuegbare Stuecke) statt
    // legacy product.quantity. Eine Query fuer alle Produkte (Bulk).
    const agg = lotAgg;
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
        label: productDisplayName(p),
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
  const bulkLots = useSharedRead('bulk_metals.lots_for_sale.get', {}, (ctx) => ({ lots: bulkLotsForSaleFor(ctx) }),
    { lots: [] as BulkLotForSale[] }, [lines.length]).lots;
  // BULK METAL V1 — COGS-Vorschau je offener Bulk-Zeile (nur Anzeige; gespeichert wird die Zuteilung des Hauses).
  const bulkPreviewKey = lines.map((l) => l.bulk && !l.bulk.kept ? `${l.bulk.lotId}:${l.bulk.weightText}` : '').join('|');
  useEffect(() => {
    lines.forEach((l, idx) => {
      const b = l.bulk;
      if (!b || b.kept || !b.lotId || b.previewCogsFils !== undefined) return;
      let mg: number;
      try { mg = parseGramsToMg(b.weightText.trim()); } catch { return; }
      void previewBulkCogs(b.lotId, mg).then((cogs) => setLines((prev) => prev.map((x, i) => (
        i === idx && x.bulk && x.bulk.lotId === b.lotId && x.bulk.weightText === b.weightText ? { ...x, bulk: { ...x.bulk, previewCogsFils: cogs } } : x
      ))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkPreviewKey]);
  const computed = lines.map(l => {
    if (l.bulk) {
      const b = l.bulk;
      const lot = bulkLots.find((x) => x.lotId === b.lotId);
      const scheme = (b.kept?.scheme || lot?.saleTaxScheme || 'MARGIN') as 'VAT_10' | 'ZERO' | 'MARGIN';
      const vatRate = scheme === 'ZERO' ? 0 : 10;
      const cogs = b.kept ? b.kept.cogsFils : (b.previewCogsFils ?? 0);
      let unitNet = 0;
      try { unitNet = netFilsFromGross(parseBhdToFils(b.grossText.trim(), true), scheme) / 1000; } catch { unitNet = 0; }
      const calc = calcLine(unitNet, 1, cogs / 1000, scheme, vatRate);
      return { product: undefined, lots: [] as Array<StockLot & { purchaseNumber: string | null }>,
        selectedLot: null as (StockLot & { purchaseNumber: string | null }) | null,
        kept: null as DraftLine['kept'] | null, lotIdOut: b.lotId as string | undefined, costBasis: cogs / 1000,
        keptShort: null as string | null, scheme, vatRate,
        net: calc.netAmount, vat: calc.vatAmount, internalVat: calc.internalVatAmount || 0, gross: calc.grossAmount };
    }
    const product = products.find(p => p.id === l.productId);
    if (!product) {
      return { product: undefined, lots: [] as Array<StockLot & { purchaseNumber: string | null }>,
        selectedLot: null as (StockLot & { purchaseNumber: string | null }) | null,
        kept: null as DraftLine['kept'] | null, lotIdOut: undefined as string | undefined, costBasis: 0,
        keptShort: null as string | null,
        scheme: 'VAT_10' as const, vatRate: 10, net: 0, vat: 0, internalVat: 0, gross: 0 };
    }
    const lots = loseJeArtikel.get(product.id)?.lots ?? [];
    // INVOICE-EDIT S2 — eine fortgesetzte Zeile rechnet mit IHREM Los und Einstand (das Haus tut
    // es beim Speichern genauso); ein offenes Los ist hier keine Wahl. Braucht sie mehr, als ihr Los
    // noch hat, sagt die Maske das vor dem Speichern — mit demselben Satz wie das Haus.
    const kept = keptOf(l);
    const selectedLot = kept
      ? (lots.find(lot => lot.id === kept.lotId) || null)
      : (lots.find(lot => lot.id === l.lotId) || lots[0] || null);
    const costBasis = kept ? kept.cost : (selectedLot ? selectedLot.unitCost : (product.purchasePrice || 0));
    const lotIdOut = kept ? (kept.lotId ?? undefined) : selectedLot?.id;
    const keptRest = selectedLot ? selectedLot.qtyRemaining : 0;
    const keptShort = kept && kept.lotId && l.quantity - kept.qty > keptRest + 0.0005
      ? keptLineLotShortMessage(productDisplayName(product) || product.sku || 'this item', keptRest)
      : null;
    const resolved = (l.scheme === 'auto' ? (product.taxScheme as 'VAT_10' | 'ZERO' | 'MARGIN') : l.scheme);
    const vatRate = resolved === 'ZERO' ? 0 : 10;
    const calc = calcLine(l.unitPrice, l.quantity, costBasis, resolved, vatRate);
    return {
      product, lots, selectedLot, kept, lotIdOut, costBasis, keptShort, scheme: resolved, vatRate,
      net: calc.netAmount, vat: calc.vatAmount,
      internalVat: calc.internalVatAmount || 0, // MARGIN: VAT auf Profit (intern, nicht customer-sichtbar)
      gross: calc.grossAmount,
    };
  });

  const subtotal = computed.reduce((s, c) => s + c.net, 0);
  const totalVat = computed.reduce((s, c) => s + c.vat, 0);
  const total = subtotal + totalVat;
  // v0.8.87 — beim Anlegen: die Summe der Zahlungszeilen; beim Ändern: der bezahlte Betrag wie bisher.
  const createPaid = payRows.reduce((sum, r) => sum + Math.max(0, payAmountOf(r)), 0);
  const paidNow = isEditMode ? paidAmount : createPaid;
  const remaining = Math.max(0, total - paidNow);
  const invoiceType: 'INV' | 'PINV' = paidNow >= total && total > 0 ? 'INV' : 'PINV';

  // Der vorgeschlagene Zahlungstag ist das Rechnungsdatum — bis der Mensch den Tag einer Zeile selbst wählt.
  useEffect(() => {
    setPayRows(prev => prev.map(r => (r.dateTouched || r.date === issuedDate ? r : { ...r, date: issuedDate })));
  }, [issuedDate]);
  function updatePayRow(key: number, patch: Partial<PayRow>) {
    setPayRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addPayRow() {
    setPayRows(prev => {
      if (prev.length >= MAX_CREATE_PAYMENTS) return prev;
      const open = Math.max(0, total - prev.reduce((sum, r) => sum + Math.max(0, payAmountOf(r)), 0));
      return [...prev, { key: payRowSeq, method: 'cash', cardBrand: 'normal', amountText: open > 0.0005 ? open.toFixed(3) : '', date: issuedDate, dateTouched: false }];
    });
    setPayRowSeq(n => n + 1);
  }
  function removePayRow(key: number) {
    setPayRows(prev => (prev.length === 1 ? [{ ...prev[0], amountText: '' }] : prev.filter(r => r.key !== key)));
  }
  /** Die Kartengebühr einer Zeile als Vorschau — nur, wo die Sätze liegen (Primary); gebucht wird sie im Haus. */
  function cardFeePreview(r: PayRow): number | null {
    if (anlegen.remote || r.method !== 'card' || !(payAmountOf(r) > 0)) return null;
    try { return computeCardFee(currentBranchId(), payAmountOf(r), r.cardBrand); } catch { return null; }
  }
  /** v0.8.87 — Debit ohne gespeicherten Satz (nur am Primary sichtbar; fern sagt es das Haus beim Speichern). */
  function debitFeeMissing(r: PayRow): boolean {
    if (anlegen.remote || r.method !== 'card' || r.cardBrand !== 'debit') return false;
    try { return !cardFeeConfigured(currentBranchId(), 'debit'); } catch { return false; }
  }

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  function pickProductForLine(idx: number, productId: string) {
    const p = products.find(pp => pp.id === productId);
    if (!p) return;
    // Phase 3 — beim Produktwechsel gilt FIFO: der aelteste aktive Lot.
    // R4A.1 — die Wahl bleibt offen (`lotId: undefined`) statt hier eine eigene Abfrage zu
    // stellen; das Zeichnen setzt danach genau denselben Lot (`lots.find(...) || lots[0]`), und
    // gespeichert wird ebenfalls dieser. Gleiches Ergebnis, ohne Datenbank im Klick.
    updateLine(idx, {
      productId,
      lotId: undefined,
      unitPrice: p.plannedSalePrice ?? p.purchasePrice ?? 0,
    });
  }

  function addLine() {
    setLines(prev => [...prev, { productId: '', scheme: 'auto', quantity: 1, unitPrice: 0 }]);
  }

  // BULK METAL V1 — eine Bulk-Zeile (Lot manuell wählen).
  function addBulkLine() {
    setLines(prev => [...prev, { productId: '', scheme: 'auto', quantity: 1, unitPrice: 0,
      bulk: { lotId: '', weightText: '', bulkType: 'RING', grossText: '', description: '' } }]);
  }

  function removeLine(idx: number) {
    setLines(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));
  }

  function validate(): string | null {
    if (!customerId) return 'Please select a customer';
    if (lines.length === 0) return 'Please add at least one product';
    const bad = lines.findIndex(l => !l.productId || l.quantity <= 0 || l.unitPrice < 0);
    if (bad !== -1) return `Line ${bad + 1}: pick a product, set qty > 0, price ≥ 0`;
    const short = computed.findIndex(c => c.keptShort);
    if (short !== -1) return `Line ${short + 1}: ${computed[short].keptShort}`;
    if (isEditMode && paidAmount < 0) return 'Paid amount cannot be negative';
    if (!isEditMode) {
      for (let i = 0; i < payRows.length; i++) {
        const r = payRows[i];
        const raw = r.amountText.trim();
        if (raw === '') continue;
        const v = parseFloat(raw);
        if (!Number.isFinite(v) || v < 0) return `Payment ${i + 1}: the amount must be a number of 0 or more`;
        if (v === 0) continue;
        const dateIssue = businessDateIssue(r.date, `Payment ${i + 1} date`);
        if (dateIssue || !r.date) return dateIssue || `Payment ${i + 1}: please choose the payment date`;
        if (r.date < issuedDate) return `Payment ${i + 1}: the payment date cannot be before the invoice date`;
        if (debitFeeMissing(r)) return `Payment ${i + 1}: ${DEBIT_FEE_MISSING}`;
      }
    }
    // Überzahlung: Im EDIT-Modus erlaubt — editInvoice (S3b) verbucht den Überschuss
    // (Reduktion des Totals unter den bereits bezahlten Betrag ODER Delta-Überzahlung)
    // atomar als Customer Credit. Im CREATE-Modus (Direktverkauf) bleibt der Guard ein
    // Tippfehler-Schutz; S3a-Überzahlung läuft bewusst über den Payment-Flow am
    // Invoice-Detail (InvoiceDetail.handleRecordPayment hat dort keinen Guard).
    if (!isEditMode && createPaid > total + 0.0005) return `Paid (${fmt(createPaid)}) exceeds total (${fmt(total)})`;
    return null;
  }

  function handleSave(thenPrint: boolean) {
    setError('');
    const v = validate();
    if (v) { setError(v); return; }

    // Wird die Rechnung mit diesem Save final?
    //   Create:  paidAmount >= total
    //   Edit:    bisher nicht final + neues paid >= total
    const goingFinal = total > 0 && paidNow >= total - 0.005 && (
      !isEditMode || (editInvoice && editInvoice.status !== 'FINAL' && !editInvoice.numberFinalizedAt)
    );
    if (goingFinal) {
      setNumberDialog({ thenPrint });
      return;
    }
    void performSave(thenPrint, false);
  }

  async function performSave(thenPrint: boolean, specialMark: boolean) {
    // R6E — die Zahlung beim Anlegen geht jetzt auf BEIDEN Rechnern: sie ist ein Feld derselben
    // Absicht (`invoices.create` → `payment`), und am Primary laufen Anlegen und Zahlung in EINER
    // Transaktion (`createInvoiceOnPrimary`). Vorher waren es zwei lose Aufrufe: scheiterte die
    // Zahlung, blieb eine unbezahlte Rechnung stehen. Nur im Aendern bleibt eine Zahlung fern ein
    // ehrliches Nein (unten) — dort ist sie kein Feld.
    // v0.8.87 — die Zahlungszeilen (ohne Betrag fallen weg), je mit Weg, Kartenart und Tag.
    const zahlungen = invoiceCreatePaymentsBody(payRows.map(r => ({ amount: payAmountOf(r), method: r.method, cardBrand: r.cardBrand, paidDate: r.date })));
    // CENTRAL-C3B — dieselbe Ableitung, die der Fernauftrag benutzt. Phase 3 (Cost-Snapshot aus
    // dem gewaehlten Lot, Fallback auf products.purchase_price) und die v0.7.1-Regel fuer MARGIN
    // (internalVat persistieren) stecken jetzt in `toInvoiceLine` — eine Stelle, zwei Aufrufer.
    let bulkIntents: Array<ReturnType<typeof bulkIntentOf> | null>;
    try { bulkIntents = lines.map((l, i) => (l.bulk ? bulkIntentOf(l.bulk, computed[i].scheme) : null)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    const payload = lines.map((l, i) => {
      const c = computed[i];
      const bi = bulkIntents[i];
      if (bi) {
        return { productId: l.productId, quantity: 1, unitPrice: 0, purchasePrice: 0, taxScheme: c.scheme, vatRate: c.vatRate,
          vatAmount: 0, lineTotal: c.gross, bulkIntent: bi, ...(l.lineId ? { lineId: l.lineId } : {}) };
      }
      return { ...toInvoiceLine({
        productId: l.productId,
        lotId: c.lotIdOut,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        costBasis: c.costBasis,
        scheme: c.scheme,
      }), ...(l.lineId ? { lineId: l.lineId } : {}) };
    });

    if (isEditMode && editInvoice) {
      // Edit-Modus: ALLES (Header + Zeilen + Inventory + Ledger-Reverse+Repost +
      // optionale Delta-Zahlung + Status + Audit) atomar in editInvoice — eine
      // einzige SQL-Transaktion im Store, nicht mehr UI-orchestriert.
      const issuedIso = `${issuedDate}T00:00:00.000Z`;
      // E1: gleiche Regel wie bisher (getrimmter Grund Pflicht), Meldung aus der SSOT-Konstante,
      // damit das Reason-Feld unten den Fehler exakt matchen und inline anzeigen kann.
      const reasonCheck = checkEditReason(isEditMode, editReason);
      if (!reasonCheck.ok) { setError(reasonCheck.message); return; }
      const reason = reasonCheck.reason;
      // Delta-Zahlung nur bei Erhoehung des bezahlten Betrags (Reduktion ignoriert —
      // negatives Payment gibt es im Modell nicht). Reduktion unter paid blockiert der Store.
      const delta = paidAmount - originalPaid;
      const deltaPayment = delta > 0.001
        ? { amount: delta, method: paymentMethod, cardBrand: paymentMethod === 'card' ? cardBrand : undefined }
        : undefined;
      // CENTRAL-UI-PARITY R6B — dieselbe Absicht, zwei Anschluesse: am Primary `editInvoice` wie
      // bisher (EINE Transaktion), am Client die vorhandene Buchung `invoices.update`, die GENAU diese
      // Funktion faehrt. Eine Zahlung ist dort bewusst kein Feld (eigene Buchung) — ehrliches Nein.
      if (aendernRechnung.remote && deltaPayment) {
        setError(fehlertext(nichtAmClient('recording a payment while editing an invoice'))); return;
      }
      const fassung = editInvoice.revision;
      if (aendernRechnung.remote && !fassung) {
        setError(fehlertext(nichtAmClient('editing this invoice (no revision loaded)'))); return;
      }
      // INVOICE-EDIT S3/S5 — Kundenwechsel = Korrektur einer falschen Zuordnung: Zahlungen, Retouren,
      // Gutschriften und das Guthaben aus dieser Rechnung ziehen mit um. Das bestätigt der Mensch
      // EINMAL ausdrücklich; das Haus verlangt die Bestätigung bei Geldfluss ebenfalls. Eine neue
      // Zahlung im selben Speichern lehnt das Haus ab (sie ginge an den alten Kunden).
      const customerChanges = customerId !== editInvoice.customerId;
      let confirmCustomerChange = false;
      if (customerChanges) {
        if (deltaPayment) {
          setError('Change the customer and record the new payment in two steps: save the customer change first, then record the payment.');
          return;
        }
        const nameOf = (id: string) => {
          const c = customers.find(x => x.id === id);
          return c ? `${c.firstName} ${c.lastName}`.trim() || c.company || id : id;
        };
        // `await`: in der App ersetzt das Tauri-Dialog-Plugin `window.confirm` durch eine async
        // Fassung — ohne `await` wäre das Versprechen immer „ja", ein Abbrechen wirkungslos.
        if (!(await window.confirm(
          `Correct the customer of this invoice from ${nameOf(editInvoice.customerId)} to ${nameOf(customerId)}?\n\n`
          + (originalPaid > 0.005 ? `Payments so far: ${fmt(originalPaid)} BHD.\n` : '')
          + 'Everything booked on this invoice moves with it: receivable, payments, returns, credit notes, refunds '
          + 'and store credit from this invoice. The invoice number and all documents stay.',
        ))) return;
        confirmCustomerChange = true;
      }
      const invId = editInvoice.id;
      const r = await aendernRechnung.save({
        local: () => {
          editInvoiceFn(invId, {
            lines: payload,
            customerId,
            notes: notes || undefined,
            issuedAt: issuedIso,
            staffId: staffId || undefined,
            deltaPayment,
            reason,
            ...(confirmCustomerChange ? { confirmCustomerChange } : {}),
          });
          return {};
        },
        remote: () => ({
          id: invId,
          expectedRevision: fassung,
          reason,
          customerId,
          lines: lines.map((l, i) => bulkIntents[i] ? ({
            kind: 'bulk', ...(l.lineId ? { lineId: l.lineId } : {}), bulkLotId: bulkIntents[i]!.lotId, weightMg: bulkIntents[i]!.weightMg,
            bulkType: bulkIntents[i]!.bulkType, unitPriceFils: bulkIntents[i]!.unitPriceFils,
            ...(bulkIntents[i]!.description ? { description: bulkIntents[i]!.description } : {}),
          }) : ({
            ...(l.lineId ? { lineId: l.lineId } : {}),
            productId: l.productId,
            lotId: computed[i]?.lotIdOut ?? null,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            scheme: l.scheme,
          })),
          ...(notes ? { notes } : {}),
          ...(issuedDate ? { issuedDate } : {}),
          ...(staffId ? { staffId } : {}),
          ...(confirmCustomerChange ? { confirmCustomerChange } : {}),
        }),
      });
      if (r.kind !== 'ok') { setError(fehlertext(r)); return; }
      if (thenPrint) {
        navigate(`/invoices/${editInvoice.id}?print=1`);
      } else {
        navigate(`/invoices/${editInvoice.id}`);
      }
      return;
    }

    // CENTRAL-UI-PARITY R4B/R6E — dieselbe Absicht, zwei Anschluesse. Am Primary die Hausfolge
    // `createInvoiceInHouse` (Nummernkreis, Bestandsabzug, Steuer, Buchung, Zahlung, Endnummer —
    // alles in den Store-Funktionen, in EINER Transaktion), am Client die gepruefte Fernbuchung
    // `invoices.create`, die auf dem Primary GENAU DIESE Hausfolge ruft. Kopiert wird hier nichts.
    const r = await anlegen.save({
      local: async () => {
        const inv = await createInvoiceOnPrimary({
          customerId, lines: payload, notes: notes || undefined, issuedDate, staffId: staffId || undefined, specialMark,
          ...(zahlungen.length > 0 ? { payments: zahlungen as unknown as InvoiceCreatePayment[] } : {}),
        });
        return { invoiceId: inv.invoiceId };
      },
      remote: () => ({
        customerId,
        lines: lines.map((l, i) => bulkIntents[i] ? ({
          kind: 'bulk', bulkLotId: bulkIntents[i]!.lotId, weightMg: bulkIntents[i]!.weightMg,
          bulkType: bulkIntents[i]!.bulkType, unitPriceFils: bulkIntents[i]!.unitPriceFils,
          ...(bulkIntents[i]!.description ? { description: bulkIntents[i]!.description } : {}),
        }) : ({
          productId: l.productId,
          lotId: computed[i]?.selectedLot?.id ?? null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          scheme: l.scheme,
        })),
        ...(notes ? { notes } : {}),
        ...(issuedDate ? { issuedDate } : {}),
        ...(staffId ? { staffId } : {}),
        specialMark,
        ...(zahlungen.length > 0 ? { payments: zahlungen } : {}),
      }),
      shape: (v) => ({ invoiceId: String(v.invoiceId ?? '') }),
    });
    if (r.kind !== 'ok') { setError(fehlertext(r)); return; }

    navigate(thenPrint ? `/invoices/${r.value.invoiceId}?print=1` : `/invoices/${r.value.invoiceId}`);
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
              <div className="flex gap-2">
                <Button variant="secondary" onClick={addLine}><Plus size={12} /> Add Product</Button>
                <Button variant="secondary" onClick={addBulkLine} data-bulk-add-invoice-line><Plus size={12} /> Add bulk metal</Button>
              </div>
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
                if (l.bulk) {
                  const b = l.bulk;
                  return (
                    <BulkInvoiceLineRow key={idx} draft={b} lots={bulkLots} scheme={c.scheme}
                      cogsFils={b.kept ? b.kept.cogsFils : (b.previewCogsFils ?? null)} vat={c.vat} internalVat={c.internalVat}
                      removable={lines.length > 1} onRemove={() => removeLine(idx)}
                      onChange={(d) => {
                        const lot = bulkLots.find((x) => x.lotId === d.lotId);
                        updateLine(idx, { bulk: d, productId: d.kept ? l.productId : (lot?.productId ?? ''), quantity: 1 });
                      }} />
                  );
                }
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
                      {c.kept && (
                        <div title="This line keeps the stock lot it was sold from. To sell from another lot, add a new line."
                          style={{ marginTop: 4, fontSize: 10, color: '#9CA3AF' }}>
                          Lot · {c.selectedLot
                            ? formatLotLabel(c.selectedLot, c.selectedLot.purchaseNumber || undefined)
                            : `as sold · ${c.kept.cost.toLocaleString('en-US', { maximumFractionDigits: 0 })} BHD cost`} · fixed
                        </div>
                      )}
                      {c.keptShort && (
                        <div style={{ marginTop: 4, fontSize: 11, color: '#DC2626' }}>{c.keptShort}</div>
                      )}
                      {!c.kept && c.lots.length > 1 && (
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
                      {!c.kept && c.lots.length === 1 && c.selectedLot && (
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
                      gridTemplateColumns: '100px 1fr',
                      gap: 18,
                      alignItems: 'start',
                    }}>
                      <div style={{
                        width: 100, height: 100, borderRadius: 10,
                        background: '#FFFFFF', border: '1px solid #E5E9EE',
                        overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <CollectionProductThumb
                          product={c.product}
                          tenantId={mediaTenantId}
                          branchId={mediaBranchId}
                          imgStyle={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                          iconSize={32}
                        />
                      </div>
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
            {isEditMode ? (<>
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
                      <button key={m.id} type="button" onClick={() => setPaymentMethod(m.id)} data-invoice-pay-method={m.id}
                        className="cursor-pointer rounded"
                        style={{ padding: '8px 16px', fontSize: 13,
                          border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                          color: active ? '#0F0F10' : '#6B7280',
                          background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{m.label}</button>
                    );
                  })}
                </div>
                {/* v0.7.26 — Karten-Brand: Normal / Amex / Debit (je eigener Satz in Settings). */}
                {paymentMethod === 'card' && (
                  <div className="flex gap-2" style={{ marginTop: 10 }}>
                    {CARD_BRAND_OPTIONS.map(b => {
                      const on = cardBrand === b.id;
                      return (
                        <button key={b.id} type="button" onClick={() => setCardBrand(b.id)} data-invoice-pay-card-brand={b.id}
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
                value={paidAmount || ''} onChange={e => setPaidAmount(parseFloat(e.target.value) || 0)} data-invoice-pay-amount />
            </div>
            <div className="flex gap-2" style={{ marginTop: 14 }}>
              <button onClick={() => setPaidAmount(total)} data-invoice-pay-full
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Full
              </button>
              <button onClick={() => setPaidAmount(0)} data-invoice-pay-later
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Later
              </button>
            </div>
            </>) : (<>
            {/* v0.8.87 — mehrere Zahlungen beim Anlegen: je Weg, Kartenart, Betrag und Tag (vorbelegt: Rechnungsdatum). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }} data-invoice-pay-rows>
              {payRows.map((r, idx) => {
                const fee = cardFeePreview(r);
                return (
                  <div key={r.key} data-invoice-pay-row={idx}
                    style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr auto', gap: 12, alignItems: 'end', padding: '10px 12px', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                    <div>
                      <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>{payRows.length > 1 ? `PAYMENT ${idx + 1} · METHOD` : 'METHOD'}</span>
                      <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                        {([
                          { id: 'cash', label: 'Cash' },
                          { id: 'bank_transfer', label: 'Bank' },
                          { id: 'card', label: 'Card' },
                          { id: 'benefit', label: 'Benefit' },
                        ] as const).map(m => {
                          const active = r.method === m.id;
                          return (
                            <button key={m.id} type="button" onClick={() => updatePayRow(r.key, { method: m.id })} data-invoice-pay-method={m.id}
                              className="cursor-pointer rounded"
                              style={{ padding: '8px 14px', fontSize: 13,
                                border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                                color: active ? '#0F0F10' : '#6B7280',
                                background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                              }}>{m.label}</button>
                          );
                        })}
                      </div>
                      {r.method === 'card' && (
                        <div className="flex gap-2" style={{ marginTop: 8 }}>
                          {CARD_BRAND_OPTIONS.map(b => {
                            const on = r.cardBrand === b.id;
                            return (
                              <button key={b.id} type="button" onClick={() => updatePayRow(r.key, { cardBrand: b.id })} data-invoice-pay-card-brand={b.id}
                                className="cursor-pointer rounded"
                                style={{ padding: '5px 12px', fontSize: 12,
                                  border: `1px solid ${on ? '#0F0F10' : '#D5D9DE'}`,
                                  color: on ? '#0F0F10' : '#6B7280',
                                  background: on ? 'rgba(15,15,16,0.06)' : 'transparent',
                                }}>{b.label}</button>
                            );
                          })}
                        </div>
                      )}
                      {r.method === 'card' && (
                        debitFeeMissing(r) ? (
                          <div style={{ fontSize: 11, color: '#AA6E6E', marginTop: 6 }} data-invoice-pay-fee={idx} data-invoice-pay-fee-missing>
                            {DEBIT_FEE_MISSING}
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }} data-invoice-pay-fee={idx}>
                            {fee !== null ? <>Card fee <Bhd v={fee}/> BHD (booked with this payment)</> : 'The card fee is booked with this payment by the main computer.'}
                          </div>
                        )
                      )}
                    </div>
                    <Input label="AMOUNT (BHD)" type="number" step="0.001" min="0"
                      value={r.amountText} onChange={e => updatePayRow(r.key, { amountText: e.target.value })} data-invoice-pay-amount />
                    <Input label="PAYMENT DATE" type="date" min={issuedDate} max={latestBusinessDate()}
                      value={r.date} onChange={e => updatePayRow(r.key, { date: e.target.value, dateTouched: true })} data-invoice-pay-date />
                    <button type="button" onClick={() => removePayRow(r.key)} data-invoice-pay-remove={idx} title="Remove this payment"
                      className="cursor-pointer rounded" disabled={payRows.length === 1 && !r.amountText}
                      style={{ padding: 8, border: '1px solid #D5D9DE', background: 'transparent', color: '#9CA3AF', marginBottom: 2 }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2" style={{ marginTop: 14 }}>
              <button onClick={addPayRow} data-invoice-pay-add disabled={payRows.length >= MAX_CREATE_PAYMENTS}
                className="cursor-pointer rounded flex items-center gap-1"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #0F0F10', color: '#0F0F10', background: 'transparent' }}>
                <Plus size={12} /> Add Payment
              </button>
              <button data-invoice-pay-full
                onClick={() => setPayRows(prev => {
                  const last = prev[prev.length - 1];
                  const others = prev.slice(0, -1).reduce((sum, x) => sum + Math.max(0, payAmountOf(x)), 0);
                  const rest = Math.max(0, total - others);
                  return prev.map(x => (x.key === last.key ? { ...x, amountText: rest > 0.0005 ? rest.toFixed(3) : '' } : x));
                })}
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Full
              </button>
              <button data-invoice-pay-later
                onClick={() => {
                  setPayRows([{ key: payRowSeq, method: 'cash', cardBrand: 'normal', amountText: '', date: issuedDate, dateTouched: false }]);
                  setPayRowSeq(n => n + 1);
                }}
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Later
              </button>
            </div>
            {createPaid > total + 0.0005 && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6, fontSize: 12, color: '#B91C1C' }} data-invoice-pay-over>
                The payments (<strong><Bhd v={createPaid}/> BHD</strong>) exceed the total. An overpayment is recorded on the invoice page, where it becomes customer credit.
              </div>
            )}
            </>)}
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
            <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                <span className="text-overline">PAID</span>
                <div className="font-mono" style={{ fontSize: 17, color: '#7EAA6E', marginTop: 4 }}>
                  <Bhd v={paidNow}/> BHD
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

        {/* EDIT REASON — E1: Pflicht-Grund im Edit-Modus, prominent direkt vor Summary/Save.
            Eigenes Feld, getrennt von NOTES; gleicher editReason-State wie die Save-Validierung.
            Validierungsfehler wird INLINE am Feld gezeigt (roter Rand + Meldung darunter),
            nicht isoliert unten unter der Summary. Nur im Edit-Modus gerendert → Create unberührt. */}
        {isEditMode && (
          <div style={{ marginTop: 16 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>REASON FOR EDIT *</span>
              <textarea value={editReason}
                onChange={e => { setEditReason(e.target.value); if (error === EDIT_REASON_REQUIRED_MESSAGE) setError(''); }}
                rows={2}
                placeholder="Explain why this invoice is being changed... (required — saved to the audit log)"
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 13, resize: 'vertical',
                  border: `1px solid ${error === EDIT_REASON_REQUIRED_MESSAGE ? '#DC2626' : '#D5D9DE'}`,
                  borderRadius: 6, background: '#FFFFFF', color: '#0F0F10',
                }} />
              {error === EDIT_REASON_REQUIRED_MESSAGE && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#DC2626' }}>{EDIT_REASON_REQUIRED_MESSAGE}</div>
              )}
            </Card>
          </div>
        )}

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
                <div className="font-mono" style={{ fontSize: 16, color: '#86E5A4' }}><Bhd v={paidNow}/> BHD</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>REMAINING</div>
                <div className="font-mono" style={{ fontSize: 16, color: remaining > 0 ? '#FFD27D' : '#86E5A4' }}><Bhd v={remaining}/> BHD</div>
              </div>
            </div>
          </div>
        </div>

        {/* Error — E1: der Edit-Reason-Fehler wird INLINE am Reason-Feld oben gezeigt, daher hier
            unterdrückt (nicht isoliert unter der Summary doppeln). Alle anderen Fehler bleiben hier. */}
        {error && error !== EDIT_REASON_REQUIRED_MESSAGE && (
          <div data-save-error style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, fontSize: 12, color: '#DC2626' }}>
            {error}
          </div>
        )}

        {/* 8. ACTION BUTTONS */}
        <div className="flex justify-between" style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={() => navigate(isEditMode && editInvoice ? `/invoices/${editInvoice.id}` : '/invoices')}><X size={14} /> Cancel</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => handleSave(true)} disabled={anlegen.busy || aendernRechnung.busy} data-invoice-save-print><Printer size={14} /> Save & Print</Button>
            <Button variant="primary" onClick={() => handleSave(false)} disabled={anlegen.busy || aendernRechnung.busy} data-save-invoice data-invoice-save><Save size={14} /> {anlegen.busy || aendernRechnung.busy ? 'Saving…' : (isEditMode ? 'Save Changes' : 'Save Invoice')}</Button>
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
          if (ctx) void performSave(ctx.thenPrint, special);
        }}
      />
    </div>
  );
}
