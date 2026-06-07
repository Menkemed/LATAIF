import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Trash2, Save, XCircle, ShoppingBag, MessageCircle, Download, Plus } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { AddMaterialModal, type MaterialLineInput } from '@/components/work-orders/AddMaterialModal';
import { OrderLineEditModal, type OrderLineEditPatch } from '@/components/work-orders/OrderLineEditModal';
import { SourceItemsModal } from '@/components/work-orders/SourceItemsModal';
import { CancelOrderModal } from '@/components/work-orders/CancelOrderModal';
import { useOrderStore } from '@/stores/orderStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useGoldStore } from '@/stores/goldStore';
import { SettleGoldModal, type SettleGoldMode } from '@/components/repairs/SettleGoldModal';
import { useProductStore } from '@/stores/productStore';
import { formatProductMultiLine } from '@/core/utils/product-format';
import { useOrderPaymentStore } from '@/stores/orderPaymentStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { PayExpenseModal } from '@/components/expenses/PayExpenseModal';
import { query } from '@/core/db/helpers';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { vatEngine } from '@/core/tax/vat-engine';
import { usePermission } from '@/hooks/usePermission';
import type { Order, OrderLine, OrderStatus, Product, TaxScheme, GoldPayable } from '@/core/models/types';
import { ConfirmTaxSchemeModal } from '@/components/shared/ConfirmTaxSchemeModal';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { Bhd } from '@/components/ui/Bhd';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';

function fmt(v: number | undefined | null): string {
  if (v === undefined || v === null) return '0.000';
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

const STATUS_FLOW: OrderStatus[] = ['pending', 'arrived', 'notified', 'completed'];

// v0.5.0 — Icon/Label fuer Order-Line-Kinds (Produkt + Custom-Komponenten).
const COST_KIND_META: Record<string, { icon: string; label: string }> = {
  labor: { icon: '🔨', label: 'Labor' },
  diamond: { icon: '💎', label: 'Diamond' },
  stone: { icon: '🔮', label: 'Stone' },
  gold: { icon: '🥇', label: 'Gold' },
  custom: { icon: '💍', label: 'Custom' },
  product: { icon: '📦', label: 'Product' },
};

function getNextStatus(current: OrderStatus): OrderStatus | null {
  const idx = STATUS_FLOW.indexOf(current);
  if (idx === -1 || idx >= STATUS_FLOW.length - 1) return null;
  return STATUS_FLOW[idx + 1];
}

function statusLabel(s: OrderStatus): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/orders');
  const { orders, loadOrders, updateOrder, updateStatus, deleteOrder, getOrderLines,
    getBillableLines, markOrderLinesInvoiced, updateOrderLineStatus,
    addOrderLine, deleteOrderLine, updateOrderLinePrice, updateOrderLine,
    markOrderLineOrdered, cancelOrderWithMoney } = useOrderStore();
  const { categories, loadCategories } = useProductStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { goldPayables, loadGoldPayables, createGoldPayable, deleteGoldPayable } = useGoldStore();
  const { products, loadProducts, createProduct } = useProductStore();
  // v0.7.7 — expenseStore: A/P-Chip-Klick auf einer Cost-Line oeffnet das Pay-
  // Modal in-place. Cross-Store-Reload triggert nach Submit den lineRefresh-Tick.
  const { expenses, loadExpenses } = useExpenseStore();
  const [payExpenseId, setPayExpenseId] = useState<string | null>(null);
  // Plan §Order §Convert: Wenn die Order kein verlinktes Produkt hat (manuell beschrieben),
  // wird beim Convert eines automatisch erzeugt und hier gehalten — wird vom VAT-Modal +
  // handleConfirmFinalInvoice anstelle von linkedProduct verwendet.
  const [pendingProduct, setPendingProduct] = useState<Product | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Order>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // v0.7.0 — Delete einer paid Order laeuft via Cancel-Modal: erst Geld-Wahl, dann Hard-Delete.
  const [pendingHardDelete, setPendingHardDelete] = useState(false);
  const [confirmAdvance, setConfirmAdvance] = useState<OrderStatus | null>(null);
  const [showMessage, setShowMessage] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);
  const [payMethod, setPayMethod] = useState('cash');
  // v0.7.26 — Karten-Brand fuer Order-Folgezahlung (nur bei method 'card').
  const [payCardBrand, setPayCardBrand] = useState<'normal' | 'amex'>('normal');
  const [payNote, setPayNote] = useState('');
  const [showInvoiceVatConfirm, setShowInvoiceVatConfirm] = useState(false);
  // v0.6.7 — VAT-Picker auch fuer persistierte Multi-Line-Orders, damit der User
  // beim Convert-to-Invoice pro Zeile umschalten kann (Custom-Quote eingeschlossen).
  const [showPersistedVatConfirm, setShowPersistedVatConfirm] = useState(false);
  const [pendingBillable, setPendingBillable] = useState<OrderLine[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // 2026-05-16 — Pending action waiting for Number-Type selection.
  const [pendingNumberAction, setPendingNumberAction] = useState<((special: boolean) => Promise<void>) | null>(null);
  // v0.3.0 — bumpt nach Line-Status-Aenderung damit das Order-Items-Grid neu lädt
  const [lineRefresh, setLineRefresh] = useState(0);
  // Back-to-Back — Order-Line bearbeiten (Produkt/Menge/Preis/Beschreibung)
  const [editLine, setEditLine] = useState<OrderLine | null>(null);
  // Back-to-Back — Wareneingang-Auswahl-Modal
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  // Back-to-Back — "Beim Supplier bestellt" Mini-Modal (Supplier-Picker)
  const [markOrderedLine, setMarkOrderedLine] = useState<OrderLine | null>(null);
  const [markOrderedSupplier, setMarkOrderedSupplier] = useState('');
  // v0.5.0 — Add-Cost Modal (Labor/Diamond/Material-Kosten nachträglich erfassen)
  const [showAddCost, setShowAddCost] = useState(false);
  // v0.6.0 — Gold-Verbindlichkeit begleichen (Gold geben / in Geld umwandeln)
  const [settleGold, setSettleGold] = useState<{ mode: SettleGoldMode; payable: GoldPayable } | null>(null);
  const { paymentsByOrder, loadPayments, addPayment, deletePayment } = useOrderPaymentStore();
  const { createDirectInvoice, invoices, loadInvoices } = useInvoiceStore();
  const perm = usePermission();

  useEffect(() => { loadOrders(); loadCustomers(); loadProducts(); loadCategories(); loadInvoices(); loadSuppliers(); loadGoldPayables(); loadExpenses(); }, [loadOrders, loadCustomers, loadProducts, loadCategories, loadInvoices, loadSuppliers, loadGoldPayables, loadExpenses]);
  useEffect(() => { if (id) loadPayments(id); }, [id, loadPayments]);

  const payments = useMemo(() => (id ? paymentsByOrder[id] || [] : []), [id, paymentsByOrder]);
  const totalPaid = useMemo(() => payments.reduce((s, p) => s + p.amount, 0), [payments]);
  // M-08 — angezeigter offener Saldo: konvertierte Order-Payments (Geld zur Invoice
  // gewandert) ausschliessen. totalPaid (roh) bleibt fuer Flow-Logik (Convert/Delete/Cancel).
  const totalPaidActive = useMemo(() => payments.filter(p => !p.convertedToInvoice).reduce((s, p) => s + p.amount, 0), [payments]);
  // v0.3.0 — Order-Lines fuer das Fulfillment-Grid (re-lädt bei lineRefresh)
  const orderLineList = useMemo(
    () => (id ? getOrderLines(id) : []),
    [id, getOrderLines, lineRefresh, orders] // eslint-disable-line react-hooks/exhaustive-deps
  );
  // v0.5.0 — kundenseitige Positionen (Order-Items-Grid + Invoicing) vs.
  // interne Kostenpositionen (Costs-Card). Trennung per is_customer_facing.
  const customerLines = useMemo(() => orderLineList.filter(l => l.isCustomerFacing !== false), [orderLineList]);
  const costLines = useMemo(() => orderLineList.filter(l => l.isCustomerFacing === false), [orderLineList]);
  // v0.6.0 Model B — Kostenbasis des fertigen Custom-Stuecks = Summe aller
  // internen Kostenpositionen (Labor + Diamond + Gold). Wird beim Convert als
  // purchasePrice (COGS) ins erzeugte Produkt kapitalisiert.
  const customCostBasis = useMemo(
    () => orderLineList.reduce((s, l) => s + (l.costAmount || 0), 0),
    [orderLineList]
  );
  // v0.6.0 — Gold-Verbindlichkeiten (Goldschmied-Gold) dieser Order.
  const orderGoldPayables = useMemo(
    () => goldPayables.filter(gp => gp.sourceOrderId === id),
    [goldPayables, id]
  );
  // v0.5.0 — die kundenseitige Quote-Line (der Quoted Price) — falls vorhanden.
  const quoteLine = useMemo(() => customerLines.find(l => l.materialKind === 'custom'), [customerLines]);
  // Back-to-Back — pro customer-facing Zeile: gibt es einen aktiven (nicht
  // stornierten) Purchase, der sie beschafft hat? Reverse-Lookup ueber
  // purchase_lines.source_order_line_id.
  const sourcedMap = useMemo(() => {
    const map = new Map<string, { purchaseId: string; purchaseNumber: string }>();
    const ids = customerLines.map(l => l.id);
    if (ids.length === 0) return map;
    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = query(
        `SELECT pl.source_order_line_id AS olid, pl.purchase_id AS pid, p.purchase_number AS pnum
           FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
          WHERE pl.source_order_line_id IN (${placeholders}) AND p.status != 'CANCELLED'`,
        ids
      );
      for (const r of rows) {
        map.set(r.olid as string, { purchaseId: r.pid as string, purchaseNumber: r.pnum as string });
      }
    } catch { /* Migration evtl. noch nicht durch */ }
    return map;
  }, [customerLines, lineRefresh]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back-to-Back — un-beschaffte Produkt-Posten: brauchen Wareneingang (Purchase).
  // v0.6.9 — PENDING-Zeilen mit vorhandenem Lager-Bestand werden NICHT als
  // sourceCandidates gezaehlt: das Produkt liegt im Regal, keine Bestellung noetig.
  // ORDERED-Zeilen brauchen IMMER einen Wareneingang (sie sind beim Supplier
  // bestellt). PENDING + noStock braucht einen (noch zu erstellen).
  const sourceCandidates = useMemo(
    () => customerLines.filter(l => {
      if (l.invoiceId || l.materialKind || sourcedMap.has(l.id)) return false;
      if (l.status === 'ORDERED') return true;
      if (l.status !== 'PENDING') return false;
      const lp = l.productId ? products.find(p => p.id === l.productId) : undefined;
      const noStock = !lp || (lp.quantity ?? 0) <= 0;
      return noStock;
    }),
    [customerLines, sourcedMap, products]
  );

  const order = useMemo(() => orders.find(o => o.id === id), [orders, id]);
  const customer = useMemo(
    () => order ? customers.find(c => c.id === order.customerId) : undefined,
    [order, customers],
  );
  // Plan §Order: Produkt-Link kann via productId (Standard-Sourcing-Flow, item arrived in stock)
  // ODER via existingProductId (Existing-Item-Flow, Order referenziert direkt vorhandenes Produkt) sein.
  // Convert-to-Invoice braucht beides — sonst zeigt es bei Existing-Item-Orders faelschlich
  // "no product linked".
  const linkedProduct = useMemo(() => {
    if (!order) return undefined;
    const pid = order.productId || order.existingProductId;
    return pid ? products.find(p => p.id === pid) : undefined;
  }, [order, products]);
  const productForConvert = linkedProduct ?? pendingProduct;

  useEffect(() => {
    if (order) setForm({ ...order });
  }, [order]);

  if (!order) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Order not found</p>
      </div>
    );
  }

  const nextStatus = getNextStatus(order.status);
  const isCancelled = order.status === 'cancelled';
  const isCompleted = order.status === 'completed';
  const remaining = (order.agreedPrice || 0) - totalPaidActive;
  const fullyPaid = (order.agreedPrice || 0) > 0 && totalPaidActive >= (order.agreedPrice || 0);

  function handleAddPayment() {
    if (!id) return;
    const amt = Number(payAmount);
    if (!amt || amt <= 0) { alert('Enter a valid amount.'); return; }
    addPayment({
      orderId: id,
      amount: amt,
      paidAt: payDate,
      method: payMethod,
      cardBrand: payMethod === 'card' ? payCardBrand : undefined,
      note: payNote || undefined,
    });
    setPayAmount(''); setPayNote(''); setPayDate(new Date().toISOString().split('T')[0]);
    setShowPayment(false);
  }

  // v0.5.0 — Kostenposition nachträglich erfassen (Quote-first „cost-later").
  // Wird als ARRIVED angelegt → commitOrderLineExpenses bucht die A/P sofort.
  function handleAddCostMaterial(data: MaterialLineInput) {
    if (!id) return;
    const ctLabel = (data.materialKind === 'diamond' || data.materialKind === 'stone')
      ? `${data.quantity}× ${(data.caratPerPiece || 0).toFixed(2)}ct `
      : '';
    // v0.6.0 — Goldschmied-Gold (Gold-Kind + Supplier) → Gold-Verbindlichkeit
    // (Gramm) statt Geld-A/P. Die Cost-Line traegt dann KEINEN Supplier — sie
    // ist nur der COGS-Wert; die Gramm-Schuld lebt im gold_payable.
    const goldAsPayable = data.materialKind === 'gold' && !!data.supplierId && (data.weightGrams || 0) > 0;
    try {
      const newLineId = addOrderLine(id, {
        description: `${ctLabel}${data.description}`.trim(),
        quantity: 1,
        unitPrice: 0,
        isCustomerFacing: false,
        materialKind: data.materialKind,
        supplierId: goldAsPayable ? undefined : (data.supplierId || undefined),
        costAmount: data.totalCost,
        status: 'ARRIVED',
        materialDetails: {
          ct: data.caratPerPiece,
          qty: data.quantity,
          description: data.description,
          karat: data.karat,
          weightGrams: data.weightGrams,
          supplierName: data.supplierName,
        },
      });
      // v0.6.5 — Gramm-Schuld mit der eben erzeugten Kostenzeile verknuepfen,
      // damit sie beim Loeschen der Zeile automatisch mitentfernt wird.
      if (goldAsPayable && data.supplierId) {
        createGoldPayable({
          supplierId: data.supplierId,
          sourceOrderId: id,
          sourceOrderLineId: newLineId,
          weightGrams: data.weightGrams!,
          karat: data.karat || '22K',
        });
        loadGoldPayables();
      }
      setLineRefresh(k => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  // v0.5.0 — Order-Beleg (Quotation) — Bestellbestätigung für den Kunden bei Anlage.
  function handleDownloadOrderReceipt() {
    if (!order) return;
    const itemDesc = `${order.requestedBrand || ''} ${order.requestedModel || ''}`.trim() || 'Custom Order';
    downloadPdf({
      title: `Order Receipt — ${order.orderNumber}`,
      number: order.orderNumber,
      date: order.createdAt?.split('T')[0] || new Date().toISOString().split('T')[0],
      subtitle: 'Order confirmation / quotation',
      customer: customer
        ? { name: `${customer.firstName} ${customer.lastName}`, company: customer.company, phone: customer.phone }
        : undefined,
      type: 'receipt',
      sections: [
        { title: 'Order', lines: [
          { label: 'Order Number', value: order.orderNumber },
          { label: 'Item', value: itemDesc },
          ...(order.requestedDetails ? [{ label: 'Details', value: order.requestedDetails }] : []),
          ...(order.expectedDelivery ? [{ label: 'Expected Delivery', value: order.expectedDelivery }] : []),
        ]},
        { title: 'Pricing', lines: [
          { label: 'Quoted / Agreed Price (approx.)', value: `${fmt(order.agreedPrice)} BHD`, bold: true },
          { label: 'Deposit Paid', value: `${fmt(totalPaidActive)} BHD` },
          { label: 'Remaining', value: `${fmt(Math.max(0, remaining))} BHD` },
        ]},
      ],
      footer: 'Thank you for your order. The quoted price is approximate and confirmed on the final invoice.',
    });
  }

  function handleDownloadReceipt(p: { id: string; amount: number; paidAt: string; method?: string; reference?: string; note?: string }) {
    if (!order) return;
    // Plan §Print — Item-Beschreibung mit allen Specs (vom verknüpften Produkt oder Order-Attributen).
    const linkedProduct = order.existingProductId ? products.find(pp => pp.id === order.existingProductId) : undefined;
    const itemDesc = linkedProduct
      ? formatProductMultiLine(linkedProduct, categories)
      : (() => {
          const head = `${order.requestedBrand || ''} ${order.requestedModel || ''}`.trim();
          const cat = categories.find(c => c.id === order.categoryId);
          if (!cat) return head;
          const lines: string[] = [head];
          for (const attr of cat.attributes || []) {
            if (attr.key === 'description') continue;
            const v = (order.attributes as Record<string, unknown> | undefined)?.[attr.key];
            if (v === undefined || v === null || v === '') continue;
            const formatted = attr.type === 'boolean' ? (v ? 'Yes' : 'No')
              : Array.isArray(v) ? v.join(', ')
              : attr.unit ? `${v} ${attr.unit}` : String(v);
            lines.push(`${attr.label}: ${formatted}`);
          }
          return lines.join('\n');
        })();
    downloadPdf({
      title: `Payment Receipt \u2014 ${order.orderNumber}`,
      number: `${order.orderNumber}-${p.id.slice(0, 6).toUpperCase()}`,
      date: p.paidAt,
      subtitle: `Receipt for payment on order ${order.orderNumber}`,
      customer: customer ? { name: `${customer.firstName} ${customer.lastName}`, company: customer.company, phone: customer.phone } : undefined,
      type: 'receipt',
      sections: [
        { title: 'Order', lines: [
          { label: 'Order Number', value: order.orderNumber },
          { label: itemDesc, value: '' },
          ...(order.agreedPrice ? [{ label: 'Agreed Price', value: `${fmt(order.agreedPrice)} BHD` }] : []),
        ]},
        { title: 'Payment', lines: [
          { label: 'Amount Received', value: `${fmt(p.amount)} BHD`, bold: true },
          { label: 'Date', value: p.paidAt },
          ...(p.method ? [{ label: 'Method', value: p.method.replace('_', ' ') }] : []),
          ...(p.reference ? [{ label: 'Reference', value: p.reference }] : []),
          ...(p.note ? [{ label: 'Note', value: p.note }] : []),
        ]},
        { title: 'Balance', lines: [
          { label: 'Total Paid (incl. this)', value: `${fmt(totalPaidActive)} BHD` },
          ...(order.agreedPrice ? [{ label: 'Remaining', value: `${fmt(Math.max(0, order.agreedPrice - totalPaidActive))} BHD` }] : []),
        ]},
      ],
      footer: 'Thank you for your payment.',
    });
  }

  function handleSave() {
    if (!id) return;
    // v0.5.0 — Quoted Price ändern: existiert eine Custom-Quote-Line, ziehen
    // wir ihren Preis + agreed_price konsistent mit (sonst nähme der Convert
    // den alten Wert). Bei Normal-Orders direkt der Header-Wert.
    if (quoteLine && form.agreedPrice != null
        && Math.abs(form.agreedPrice - (quoteLine.unitPrice || 0)) > 0.0005) {
      try {
        updateOrderLinePrice(quoteLine.id, form.agreedPrice);
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    const margin =
      form.agreedPrice && form.supplierPrice
        ? form.agreedPrice - form.supplierPrice
        : undefined;
    const rem = (form.agreedPrice || 0) - (form.depositAmount || 0);
    updateOrder(id, {
      ...(quoteLine ? {} : { agreedPrice: form.agreedPrice }),
      depositAmount: form.depositAmount,
      supplierName: form.supplierName,
      supplierPrice: form.supplierPrice,
      expectedMargin: margin,
      expectedDelivery: form.expectedDelivery,
      remainingAmount: rem,
      notes: form.notes,
    });
    setEditing(false);
  }

  function handleAdvance(status: OrderStatus) {
    if (!id) return;
    updateStatus(id, status);
    setConfirmAdvance(null);
  }

  // Back-to-Back — Order-Position bearbeiten (Produkt/Menge/Preis/Beschreibung).
  function handleSaveOrderLine(patch: OrderLineEditPatch) {
    if (!editLine) return;
    try {
      updateOrderLine(editLine.id, patch);
      setEditLine(null);
      setLineRefresh(k => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  function handleCancel(choice: 'refund' | 'credit' | 'forfeit', refundMethod?: 'cash' | 'bank' | 'benefit') {
    if (!id) return;
    try {
      cancelOrderWithMoney(id, choice, refundMethod);
      setConfirmCancel(false);
      // v0.7.0 — wenn der Cancel-Wizard ueber den Delete-Button getriggert wurde,
      // direkt im Anschluss Hard-Delete + zurueck zur Liste.
      if (pendingHardDelete) {
        setPendingHardDelete(false);
        deleteOrder(id);
        navigate('/orders');
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  function handleDelete() {
    if (!id || !order) return;
    // v0.7.0 — Delete einer paid Order: erst Geld klar machen (Modal), dann
    // Hard-Delete. Bei totalPaid=0 direkt loeschen wie heute.
    if (totalPaid > 0.005) {
      setConfirmDelete(false);
      setConfirmCancel(true);  // Cancel-Wizard fuer Geld-Handling. Hard-Delete folgt.
      setPendingHardDelete(true);
      return;
    }
    deleteOrder(id);
    navigate('/orders');
  }

  // Carry-over Logik wird sowohl vom direkten als auch vom Legacy-Pfad benötigt.
  // v0.3.1 — Deposit-Pool = die noch nicht convertierten order_payments. Beim
  // (Teil-)Convert wird hoechstens das Invoice-Total angerechnet (Cap). Ein
  // Ueberschuss (Deposit > diese Invoice) bleibt als frischer order_payments-
  // Eintrag stehen und fliesst beim naechsten Convert auf die naechste Invoice.
  async function carryOverOrderPaymentsToInvoice(
    invoiceId: string, orderId: string, orderNumber: string, invoiceTotal: number,
  ) {
    const inv = useInvoiceStore.getState();
    const poolRows = query(
      `SELECT id, amount, method, card_brand FROM order_payments
         WHERE order_id = ? AND converted_to_invoice = 0
         ORDER BY paid_at ASC, created_at ASC`,
      [orderId],
    );
    const pool = poolRows.reduce((s, r) => s + Number(r.amount || 0), 0);

    // Leerer Pool: Folge-Invoice nach verbrauchtem Deposit → startet UNPAID.
    // Legacy-Fallback: alte Orders ohne order_payments-Zeilen (Deposit nur auf
    // der orders-Zeile) — einmalig, gedeckelt aufs Invoice-Total.
    if (pool <= 0.005) {
      if (poolRows.length === 0 && totalPaid > 0) {
        inv.recordPayment(invoiceId, Math.min(totalPaid, invoiceTotal), 'cash',
          `Carried over from order ${orderNumber}`);
      }
      return;
    }

    // ZIEL.md §3a — Order-Payment-Ledger reversen + converted-Flag setzen, BEVOR
    // die Invoice-Payments gepostet werden (sonst doppelt-Cash). Idempotent.
    useOrderPaymentStore.getState().markConvertedToInvoice(orderId);

    // Cap: hoechstens das Invoice-Total auf diese Invoice anrechnen.
    const cap = Math.min(pool, invoiceTotal);
    let budget = cap;
    let lastMethod = 'cash';
    let lastBrand: 'normal' | 'amex' | undefined;
    for (const r of poolRows) {
      if (budget <= 0.005) break;
      const take = Math.min(Number(r.amount || 0), budget);
      lastMethod = (r.method as string) || 'cash';
      // v0.7.26 — Karten-Brand der Order-Zahlung mitnehmen: die Order-CardFee wurde
      // beim Convert reversed (markConvertedToInvoice); die Invoice bucht hier eine
      // frische CardFee mit der richtigen Rate (Amex 2,5% / Normal 2,2%).
      lastBrand = lastMethod === 'card' ? ((r.card_brand as 'normal' | 'amex') || 'normal') : undefined;
      inv.recordPayment(invoiceId, take, lastMethod, `Carried over from order ${orderNumber}`, undefined, lastBrand);
      budget -= take;
    }

    // Ueberschuss → neuer Deposit-Eintrag fuer die naechste Teil-Invoice.
    const remainder = pool - cap;
    if (remainder > 0.005) {
      useOrderPaymentStore.getState().addPayment({
        orderId,
        amount: remainder,
        paidAt: new Date().toISOString().split('T')[0],
        method: lastMethod,
        cardBrand: lastBrand,
        note: `Deposit remainder after partial invoice for order ${orderNumber}`,
      });
    }
  }

  async function handleCreateFinalInvoice() {
    if (!id || !order) return;

    // v0.3.0 — Partielles Invoicing: nur Lines die fertig (ARRIVED/DELIVERED)
    // + customer-facing + noch nicht invoiced sind werden gebillt.
    const billable = getBillableLines(id);
    if (billable.length === 0) {
      alert('Nothing ready to invoice. Mark order items as "Arrived" before creating an invoice.');
      return;
    }

    // v0.6.7 — Guard: Custom-Stuecke duerfen nicht ohne erfasste Kosten gebucht
    // werden. Ohne Kosten (customCostBasis = 0) wuerde der Convert die volle
    // Quoted-Summe als Marge buchen → COGS = 0, Marge falsch, Lager-Wert falsch.
    // Pflicht: erst Labor/Material/Gold ueber „Add Cost" erfassen.
    const hasCustomLine = billable.some(l => l.materialKind === 'custom');
    if (hasCustomLine && customCostBasis <= 0) {
      alert(
        'Custom piece has no costs recorded yet.\n\n' +
        'Please enter the actual costs (labor / material / gold) via "Add Cost" first — ' +
        'otherwise the full quoted amount is booked as margin (COGS = 0).'
      );
      return;
    }

    // v0.6.7 — Auch bei persistierten Lines den VAT-Picker zeigen, damit der
    // User pro Zeile (inkl. Custom-Quote) das Schema noch umstellen kann bevor
    // die Rechnung erzeugt wird. Vorher: stilles 1:1 Durchreichen.
    const allPersisted = billable.every(l => !!l.taxScheme);
    if (allPersisted) {
      setPendingBillable(billable);
      setShowPersistedVatConfirm(true);
      return;
    }
    const gross = order.agreedPrice || totalPaid;
    if (gross <= 0) { alert('Agreed price required.'); return; }

    // Legacy-Order ohne Scheme-Snapshot (vor v0.1.15 angelegt) → Modal als Fallback.
    if (!linkedProduct) {
      // v0.6.7 — Wenn der Custom-Order eine strukturierte Produkt-Spec mitbringt
      // (Karte 3e via NewProductModal), das Convert-Produkt damit anlegen.
      // Sonst Fallback auf die Legacy-Felder (requestedBrand/Model/...).
      const spec = order.customProductSpec || {};
      const newProduct = createProduct({
        categoryId: spec.categoryId || order.categoryId || '',
        brand: spec.brand || order.requestedBrand || '',
        name: spec.name || order.requestedModel || order.requestedBrand || 'Custom Item',
        sku: spec.sku,
        condition: spec.condition || order.condition || '',
        attributes: (spec.attributes as Record<string, string | number | boolean | string[]>) || order.attributes || {},
        images: spec.images || [],
        scopeOfDelivery: spec.scopeOfDelivery || [],
        // v0.6.0 Model B — Kostenbasis = kapitalisierte Custom-Kosten (COGS),
        // sonst Supplier-Preis. Kein Purchase, kein Lager-Durchlauf.
        purchasePrice: customCostBasis > 0 ? customCostBasis : (order.supplierPrice || 0),
        plannedSalePrice: order.agreedPrice,
        // v0.6.0 — made-to-order, geht direkt auf die Invoice → nie 'in_stock'.
        stockStatus: 'reserved',
        taxScheme: spec.taxScheme || 'MARGIN',
        sourceType: 'OWN',
        supplierName: order.supplierName,
        notes: spec.notes
          || (order.requestedDetails ? `From order ${order.orderNumber}: ${order.requestedDetails}` : `From order ${order.orderNumber}`),
      });
      setPendingProduct(newProduct);
      updateOrder(id, { productId: newProduct.id });
    }
    setShowInvoiceVatConfirm(true);
  }

  // Direkter Convert-Pfad: Pro Order-Line wird eine Invoice-Line gebaut, mit
  // der in OrderCreate gewählten Scheme. order_lines.unit_price ist Netto pro Stück
  // (siehe OrderCreate.unitNetFromGross), daher: lineNet = unitPrice × qty,
  // dann vatEngine.calculateNet → vat + gross. Keine Doppelbesteuerung möglich,
  // weil wir nicht erneut auf einen schon-gross-Wert rechnen.
  async function convertWithPersistedSchemes(
    orderLines: OrderLine[],
    specialMark: boolean = false,
    perLineSchemes?: Record<string, TaxScheme>,
  ) {
    if (!id || !order) return;

    // v0.3.0 — defensiv: nur customer-facing Lines invoicen (cost-only NIE).
    const billableLines = orderLines.filter(l => l.isCustomerFacing !== false);
    if (billableLines.length === 0) {
      alert('Keine customer-facing Lines zum Invoicen.');
      return;
    }

    const invoiceLineInputs: Array<{
      productId: string; quantity: number; unitPrice: number; purchasePrice: number;
      taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number;
    }> = [];

    for (const ol of billableLines) {
      // v0.6.7 — Schema aus dem ConfirmTaxSchemeModal-Override, sonst persistiert.
      const scheme = (perLineSchemes?.[ol.id] as TaxScheme | undefined) || (ol.taxScheme as TaxScheme);
      const rate = scheme === 'ZERO' ? 0 : 10;
      let prod = ol.productId ? products.find(p => p.id === ol.productId) : undefined;
      // Für freitext-Lines ohne Produkt eines auto-erzeugen — analog zum bisherigen
      // Single-Line-Auto-Create, nur jetzt pro Line.
      if (!prod) {
        // v0.6.0 Model B — das Custom-Stueck wird gefertigt, nicht gekauft:
        // seine Kostenbasis (COGS) = Summe der internen Kostenpositionen der
        // Order. Kein Purchase, kein Lager-Durchlauf ('reserved' statt 'in_stock').
        const isCustomPiece = ol.materialKind === 'custom';
        // v0.6.7 — bei Custom-Quote die strukturierte Produkt-Spec nutzen wenn da.
        const spec = isCustomPiece ? (order.customProductSpec || {}) : {};
        prod = createProduct({
          categoryId: spec.categoryId || order.categoryId || '',
          brand: spec.brand || order.requestedBrand || '',
          name: spec.name || ol.description || order.requestedModel || 'Custom Item',
          sku: spec.sku,
          condition: spec.condition || order.condition || '',
          attributes: (spec.attributes as Record<string, string | number | boolean | string[]>) || order.attributes || {},
          images: spec.images || [],
          scopeOfDelivery: spec.scopeOfDelivery || [],
          purchasePrice: isCustomPiece ? customCostBasis : 0,
          plannedSalePrice: ol.unitPrice * Math.max(1, ol.quantity),
          stockStatus: 'reserved',
          taxScheme: scheme,
          sourceType: 'OWN',
          notes: spec.notes || `From order ${order.orderNumber}`,
        });
      }
      const qty = Math.max(1, ol.quantity);
      // v0.6.7 — Custom-Quote-Lines speichern BRUTTO (Quoted Price = Endpreis).
      // Bei VAT_10 auf Custom: lineNet aus brutto decomposen, sonst rechnet
      // calculateNet 10% on-top und der Kunde wuerde Quoted * 1.10 zahlen.
      // Normal-Produkt-Lines speichern Netto (siehe OrderCreate.unitNetFromGross),
      // dort lineNet = unitPrice * qty wie bisher.
      const grossPerLine = ol.unitPrice * qty;
      let lineNet: number;
      if (ol.materialKind === 'custom' && scheme === 'VAT_10') {
        lineNet = grossPerLine / 1.10;
      } else {
        lineNet = grossPerLine;
      }
      const calc = vatEngine.calculateNet(lineNet, (prod.purchasePrice || 0) * qty, scheme, rate);
      // v0.7.1 — NBR: MARGIN persistiert internalVatAmount damit MARGIN_VAT-Ledger
      // + invoice.vatAmount-Hero korrekt sind. Display-Schicht versteckt VAT bei
      // MARGIN-Print weiterhin (gesetzliche Differenzbesteuerung).
      const persistedVat = calc.internalVatAmount ?? calc.vatAmount;
      invoiceLineInputs.push({
        productId: prod.id,
        quantity: qty,
        unitPrice: lineNet / qty,
        purchasePrice: prod.purchasePrice || 0,
        taxScheme: scheme,
        vatRate: rate,
        vatAmount: persistedVat,
        lineTotal: calc.grossAmount,
      });
    }

    const invoice = createDirectInvoice(
      order.customerId,
      invoiceLineInputs,
      `Invoice for order ${order.orderNumber}`,
      undefined,
      undefined,
      undefined,
      specialMark,
    );
    // v0.3.0 — invoicte Lines mit der Invoice verknuepfen (partial invoicing).
    markOrderLinesInvoiced(billableLines.map(l => l.id), invoice.id);
    updateOrder(id, { invoiceId: invoice.id });
    setPendingProduct(null);
    // v0.3.1 — Deposit-Pool auf die Invoice anrechnen, gedeckelt aufs Invoice-Total.
    // Ein Ueberschuss bleibt fuer die naechste Teil-Invoice stehen; ist der Pool
    // leer (Deposit schon verbraucht), startet diese Invoice UNPAID.
    await carryOverOrderPaymentsToInvoice(invoice.id, id, order.orderNumber, invoice.grossAmount);
    navigate(`/invoices/${invoice.id}`);
  }

  // Legacy-Pfad nur für Orders ohne persistierten Scheme-Snapshot.
  // KRITISCHER FIX: order.agreedPrice ist GROSS (= subtotal + totalVat in OrderCreate),
  // nicht NET. Vorher wurde es 1:1 in calculateNet() reingegeben → bei VAT_10
  // wurden 10% nochmal on top gerechnet → Doppelbesteuerung. Jetzt: Decompose
  // Gross → Net je nach gewähltem Scheme, dann calculateNet → resultierender
  // Gross == ursprünglicher agreedPrice.
  async function handleConfirmFinalInvoice(perLine: Record<string, TaxScheme>) {
    setShowInvoiceVatConfirm(false);
    // Nach VAT-Confirm — Number-Type-Dialog vor dem Create.
    setPendingNumberAction(() => async (special: boolean) => executeLegacyFinalInvoice(perLine, special));
  }

  async function executeLegacyFinalInvoice(perLine: Record<string, TaxScheme>, specialMark: boolean) {
    const prod = productForConvert;
    if (!id || !order || !prod) return;
    const grossAgreed = order.agreedPrice || totalPaid;
    if (grossAgreed <= 0) { alert('Agreed price required.'); return; }
    const taxScheme = (perLine[prod.id] || prod.taxScheme || 'MARGIN') as TaxScheme;
    const vatRate = taxScheme === 'ZERO' ? 0 : 10;
    const netInput = taxScheme === 'VAT_10'
      ? grossAgreed / (1 + vatRate / 100)
      : grossAgreed;
    const calc = vatEngine.calculateNet(netInput, prod.purchasePrice || 0, taxScheme, vatRate);
    // v0.7.1 — NBR: siehe analoge Stelle weiter oben.
    const persistedVat = calc.internalVatAmount ?? calc.vatAmount;
    const invoice = createDirectInvoice(
      order.customerId,
      [{
        productId: prod.id,
        unitPrice: calc.netAmount,
        purchasePrice: prod.purchasePrice || 0,
        taxScheme,
        vatRate,
        vatAmount: persistedVat,
        lineTotal: calc.grossAmount,
      }],
      `Final invoice for order ${order.orderNumber}`,
      undefined,
      undefined,
      undefined,
      specialMark,
    );
    updateOrder(id, { invoiceId: invoice.id });
    setPendingProduct(null);
    await carryOverOrderPaymentsToInvoice(invoice.id, id, order.orderNumber, invoice.grossAmount);
    navigate(`/invoices/${invoice.id}`);
  }

  function renderField(label: string, value: React.ReactNode, editField?: React.ReactNode) {
    return (
      <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
        <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
        {editing && editField ? editField : <span style={{ fontSize: 13, color: '#0F0F10' }}>{value || '\u2014'}</span>}
      </div>
    );
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={goBack}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...order }); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={handleDownloadOrderReceipt}>
                  <Download size={14} /> Order Receipt
                </Button>
                {order.status === 'arrived' && customer && (
                  <Button variant="secondary" onClick={() => setShowMessage(true)}>
                    <MessageCircle size={14} /> AI Notify Arrival
                  </Button>
                )}
                {!isCancelled && !isCompleted && perm.canManageOrders && (
                  <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>
                )}
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                {!isCancelled && !isCompleted && perm.canManageOrders && (
                  <Button variant="danger" onClick={() => setConfirmCancel(true)}><XCircle size={14} /> Cancel Order</Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>
          {/* Icon / Order Visual */}
          <div className="rounded-xl flex items-center justify-center"
            style={{ height: 400, background: '#F2F7FA', border: '1px solid #E5E9EE' }}>
            <ShoppingBag size={64} strokeWidth={0.8} style={{ color: '#6B7280' }} />
          </div>

          {/* Key Info */}
          <div>
            <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>{order.orderNumber}</span>
            <span className="text-overline">{order.requestedBrand}</span>
            <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>
              {order.requestedModel}
            </h1>
            {order.requestedReference && (
              <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 8 }}>{order.requestedReference}</span>
            )}
            {order.requestedDetails && (
              <p style={{ fontSize: 13, color: '#6B7280', marginTop: 8, lineHeight: 1.6 }}>{order.requestedDetails}</p>
            )}

            <div className="flex items-center gap-4" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <StatusDot status={order.status} />
              {/* Kategorie-Badge wenn vorhanden */}
              {(() => {
                const cat = categories.find(c => c.id === order.categoryId);
                if (!cat) return null;
                return (
                  <span style={{
                    fontSize: 11, padding: '3px 12px', borderRadius: 999,
                    background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                  }}>{cat.name}</span>
                );
              })()}
              {order.condition && (
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, background: 'rgba(15,15,16,0.06)', color: '#0F0F10', border: '1px solid #D5D9DE' }}>
                  {order.condition}
                </span>
              )}
              {order.existingProductId && (
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, background: 'rgba(126,170,110,0.1)', color: '#5A8552', border: '1px solid rgba(126,170,110,0.3)' }}>
                  Existing Item
                </span>
              )}
            </div>

            {/* Kategorie-Attribute strukturiert anzeigen */}
            {order.categoryId && order.attributes && Object.keys(order.attributes).length > 0 && (() => {
              const cat = categories.find(c => c.id === order.categoryId);
              if (!cat) return null;
              const attrs = order.attributes as Record<string, string | number | boolean | string[]>;
              const visible = cat.attributes.filter(a => attrs[a.key] !== undefined && attrs[a.key] !== '' && attrs[a.key] !== null);
              if (visible.length === 0) return null;
              return (
                <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                  <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>{cat.name.toUpperCase()} DETAILS</span>
                  {visible.map(attr => {
                    const val = attrs[attr.key];
                    const display = typeof val === 'boolean' ? (val ? 'Yes' : 'No')
                      : Array.isArray(val) ? val.join(', ')
                      : String(val);
                    return (
                      <div key={attr.key} className="flex justify-between" style={{ padding: '4px 0', fontSize: 12 }}>
                        <span style={{ color: '#6B7280' }}>{attr.label}</span>
                        <span style={{ color: '#0F0F10' }}>{display}{attr.unit ? ` ${attr.unit}` : ''}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {customer && (
              <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 4 }}>Customer</span>
                <span style={{ fontSize: 14, color: '#0F0F10' }}>{customer.firstName} {customer.lastName}</span>
                {customer.company && (
                  <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginTop: 2 }}>{customer.company}</span>
                )}
              </div>
            )}

            {/* Pricing Summary */}
            <div style={{ marginTop: 28, borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">AGREED PRICE</span>
                <span className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}><Bhd v={order.agreedPrice}/> BHD</span>
              </div>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">TOTAL PAID</span>
                <span className="font-display" style={{ fontSize: 20, color: fullyPaid ? '#7EAA6E' : '#AA956E' }}>
                  <Bhd v={totalPaidActive}/> BHD
                </span>
              </div>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">REMAINING</span>
                <span className="font-mono" style={{ fontSize: 16, color: remaining <= 0 ? '#7EAA6E' : '#4B5563' }}><Bhd v={Math.max(0, remaining)}/> BHD</span>
              </div>
            </div>

            {/* Status Advance */}
            {nextStatus && !isCancelled && !editing && perm.canManageOrders && (
              <div style={{ marginTop: 20 }}>
                <Button variant="primary" onClick={() => setConfirmAdvance(nextStatus)} fullWidth>
                  Advance to {statusLabel(nextStatus)}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Edit-Item-Card — Kategorie + Brand/Name + dynamische Attribute (nur im Edit) */}
        {editing && (
          <div style={{ marginBottom: 24 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>ITEM &amp; CATEGORY</span>

              {/* Category-Selector */}
              <div style={{ marginTop: 12 }}>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CATEGORY</span>
                <div className="flex flex-wrap gap-2">
                  {categories.map(cat => {
                    const active = form.categoryId === cat.id;
                    return (
                      <button key={cat.id} type="button" onClick={() => setForm({
                        ...form,
                        categoryId: cat.id,
                        condition: active ? form.condition : (cat.conditionOptions?.[0] || ''),
                        attributes: active ? form.attributes : {},
                      })}
                        className="cursor-pointer rounded-lg"
                        style={{
                          padding: '8px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                          border: `1px solid ${active ? cat.color : '#D5D9DE'}`,
                          color: active ? cat.color : '#6B7280',
                          background: active ? cat.color + '08' : 'transparent',
                        }}>
                        <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                        {cat.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                <Input required label="BRAND" value={form.requestedBrand || ''}
                  onChange={e => setForm({ ...form, requestedBrand: e.target.value })} />
                <Input required label="NAME / MODEL" value={form.requestedModel || ''}
                  onChange={e => setForm({ ...form, requestedModel: e.target.value })} />
              </div>
              <div style={{ marginTop: 12 }}>
                <Input label="REFERENCE / SKU" value={form.requestedReference || ''}
                  onChange={e => setForm({ ...form, requestedReference: e.target.value })} />
              </div>

              {/* Dynamic Category Attributes */}
              {(() => {
                const cat = categories.find(c => c.id === form.categoryId);
                if (!cat || cat.attributes.length === 0) return null;
                const attrs = (form.attributes || {}) as Record<string, string | number | boolean | string[]>;
                function setAttr(k: string, v: string | number | boolean | string[]) {
                  setForm({ ...form, attributes: { ...attrs, [k]: v } });
                }
                return (
                  <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #E5E9EE' }}>
                    <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>{cat.name.toUpperCase()} DETAILS</span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8 }}>
                      {cat.attributes.map(attr => {
                        if (attr.type === 'select' && attr.options) {
                          return (
                            <div key={attr.key}>
                              <span className="text-overline" style={{ marginBottom: 6 }}>{attr.label.toUpperCase()}</span>
                              <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                                {attr.options.map(opt => (
                                  <button key={opt} type="button" onClick={() => setAttr(attr.key, opt)}
                                    className="cursor-pointer"
                                    style={{
                                      padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                      border: `1px solid ${attrs[attr.key] === opt ? '#0F0F10' : '#D5D9DE'}`,
                                      color: attrs[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                      background: attrs[attr.key] === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                                    }}>{opt}</button>
                                ))}
                              </div>
                            </div>
                          );
                        }
                        if (attr.type === 'boolean') {
                          return (
                            <div key={attr.key}>
                              <span className="text-overline" style={{ marginBottom: 6 }}>{attr.label.toUpperCase()}</span>
                              <div className="flex gap-2" style={{ marginTop: 6 }}>
                                {[true, false].map(v => (
                                  <button key={String(v)} type="button" onClick={() => setAttr(attr.key, v)}
                                    className="cursor-pointer rounded"
                                    style={{ padding: '6px 14px', fontSize: 12,
                                      border: `1px solid ${attrs[attr.key] === v ? '#0F0F10' : '#D5D9DE'}`,
                                      color: attrs[attr.key] === v ? '#0F0F10' : '#6B7280',
                                      background: attrs[attr.key] === v ? 'rgba(15,15,16,0.06)' : 'transparent',
                                    }}>{v ? 'Yes' : 'No'}</button>
                                ))}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <Input key={attr.key}
                            label={attr.label.toUpperCase() + (attr.unit ? ` (${attr.unit})` : '')}
                            type={attr.type === 'number' ? 'number' : 'text'}
                            value={String(attrs[attr.key] || '')}
                            onChange={e => setAttr(attr.key, attr.type === 'number' ? Number(e.target.value) : e.target.value)} />
                        );
                      })}
                    </div>
                    {cat.conditionOptions.length > 0 && (
                      <div style={{ marginTop: 14 }}>
                        <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CONDITION</span>
                        <div className="flex flex-wrap gap-2" style={{ marginTop: 6 }}>
                          {cat.conditionOptions.map(c => (
                            <button key={c} type="button" onClick={() => setForm({ ...form, condition: c })}
                              className="cursor-pointer rounded"
                              style={{ padding: '7px 14px', fontSize: 12,
                                border: `1px solid ${form.condition === c ? '#0F0F10' : '#D5D9DE'}`,
                                color: form.condition === c ? '#0F0F10' : '#6B7280',
                                background: form.condition === c ? 'rgba(15,15,16,0.06)' : 'transparent',
                              }}>{c}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </Card>
          </div>
        )}

        {/* Details Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Sourcing Card */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>SOURCING</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Input label="SUPPLIER NAME" value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} />
                  <Input label="SUPPLIER PRICE (BHD)" type="number" value={form.supplierPrice ?? ''} onChange={e => setForm({ ...form, supplierPrice: Number(e.target.value) || undefined })} />
                  <div>
                    <Input required label={quoteLine ? 'QUOTED PRICE (BHD)' : 'AGREED PRICE (BHD)'} type="number"
                      value={form.agreedPrice ?? ''}
                      onChange={e => setForm({ ...form, agreedPrice: Number(e.target.value) || undefined })}
                      disabled={!!quoteLine?.invoiceId} />
                    {quoteLine?.invoiceId && (
                      <span style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4, display: 'block' }}>
                        Already in an invoice — price only editable after cancelling the invoice.
                      </span>
                    )}
                  </div>
                  <Input label="DEPOSIT AMOUNT (BHD)" type="number" value={form.depositAmount ?? ''} onChange={e => setForm({ ...form, depositAmount: Number(e.target.value) || 0 })} />
                </div>
              ) : (
                <>
                  {renderField('Supplier', order.supplierName)}
                  {renderField('Supplier Price', order.supplierPrice !== undefined ? `${fmt(order.supplierPrice)} BHD` : undefined)}
                  {renderField('Expected Margin', order.expectedMargin !== undefined
                    ? <span className="font-mono" style={{ color: (order.expectedMargin || 0) >= 0 ? '#7EAA6E' : '#AA6E6E' }}><Bhd v={order.expectedMargin}/> BHD</span>
                    : undefined)}
                </>
              )}
            </div>
          </Card>

          {/* Delivery & Details Card */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>DELIVERY & DETAILS</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Input label="EXPECTED DELIVERY" type="date" value={form.expectedDelivery || ''} onChange={e => setForm({ ...form, expectedDelivery: e.target.value })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                    <textarea
                      value={form.notes || ''}
                      onChange={e => setForm({ ...form, notes: e.target.value })}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {renderField('Expected Delivery', order.expectedDelivery)}
                  {renderField('Actual Delivery', order.actualDelivery)}
                  {renderField('Deposit Date', order.depositDate)}
                  {renderField('Created', order.createdAt?.split('T')[0])}
                  {renderField('Updated', order.updatedAt?.split('T')[0])}
                  {order.notes && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{order.notes}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {editing && perm.canDeleteOrders && (
              <div className="flex gap-2" style={{ marginTop: 20 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Order
                </Button>
              </div>
            )}
          </Card>
        </div>

        {/* v0.3.0 — Order Items Grid mit Per-Line Fulfillment-Status (nur kundenseitige Lines) */}
        {!editing && customerLines.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                <span className="text-overline">ORDER ITEMS ({customerLines.length})</span>
                <div className="flex items-center gap-3">
                  {!isCancelled && perm.canManageOrders && sourceCandidates.length > 0 && (
                    <Button variant="secondary" onClick={() => setSourceModalOpen(true)}>
                      <Plus size={14} /> Wareneingang erfassen
                    </Button>
                  )}
                  {(() => {
                    const active = customerLines.filter(l => l.status !== 'CANCELLED');
                    const ready = active.filter(l => l.status === 'ARRIVED' || l.status === 'DELIVERED').length;
                    return (
                      <span style={{ fontSize: 11, color: '#6B7280' }}>
                        {ready} / {active.length} ready
                      </span>
                    );
                  })()}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '0.6fr 1.7fr 0.5fr 0.6fr 1.3fr 1.2fr', gap: 10, fontSize: 12 }}>
                <span className="text-overline">KIND</span>
                <span className="text-overline">DESCRIPTION</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>TOTAL</span>
                <span className="text-overline">INVOICE</span>
                <span className="text-overline">FULFILLMENT</span>
                <span className="text-overline">ACTIONS</span>
                {customerLines.map(l => {
                  const km = COST_KIND_META[l.materialKind || 'product'] || COST_KIND_META.product;
                  const costOnly = l.isCustomerFacing === false;
                  const cancelled = l.status === 'CANCELLED';
                  const dim = costOnly || cancelled;
                  const statusColors: Record<string, string> = {
                    PENDING: '#6B7280', ARRIVED: '#D97706', DELIVERED: '#16A34A', CANCELLED: '#DC2626',
                  };
                  return (
                    <div key={l.id} style={{ display: 'contents' }}>
                      <span style={{ fontSize: 12, padding: '10px 0', borderTop: '1px solid #E5E9EE', opacity: dim ? 0.5 : 1 }}>
                        {km.icon} {km.label}
                      </span>
                      <span style={{ fontSize: 13, color: '#0F0F10', padding: '10px 0', borderTop: '1px solid #E5E9EE',
                                     opacity: dim ? 0.5 : 1, textDecoration: cancelled ? 'line-through' : 'none' }}>
                        {l.description || '—'}
                        {costOnly && <span style={{ fontSize: 10, color: '#9CA3AF', marginLeft: 6 }}>(internal cost)</span>}
                      </span>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right',
                                     padding: '10px 0', borderTop: '1px solid #E5E9EE', opacity: dim ? 0.5 : 1 }}>
                        {costOnly ? '—' : <Bhd v={l.lineTotal || 0}/>}
                      </span>
                      <span style={{ fontSize: 11, padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                        {l.invoiceId
                          ? <span style={{ color: '#3D7FFF', cursor: 'pointer', textDecoration: 'underline' }}
                              onClick={() => navigate(`/invoices/${l.invoiceId}`)}>invoiced</span>
                          : <span style={{ color: '#9CA3AF' }}>—</span>}
                      </span>
                      <div style={{ padding: '7px 0', borderTop: '1px solid #E5E9EE', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {cancelled ? (
                          <span style={{ fontSize: 11, color: '#DC2626' }}>cancelled</span>
                        ) : l.status === 'ORDERED' ? (
                          // v0.6.8 — Bei ORDERED keine ARRIVED/DELIVERED-Buttons:
                          // der Statuswechsel laeuft ueber „Wareneingang erfassen"
                          // (echter Purchase). Nur ein Undo zurueck auf PENDING.
                          <>
                            <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 4,
                              background: 'rgba(217,119,6,0.1)', color: '#D97706', border: '1px solid rgba(217,119,6,0.3)' }}>
                              ORDERED
                            </span>
                            <span style={{ fontSize: 10, color: '#9CA3AF', alignSelf: 'center' }}>
                              → Wareneingang erfassen
                            </span>
                            <button type="button"
                              onClick={() => {
                                try { updateOrderLineStatus(l.id, 'PENDING'); setLineRefresh(k => k + 1); }
                                catch (e) { alert(e instanceof Error ? e.message : String(e)); }
                              }}
                              style={{ fontSize: 10, padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
                                border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}
                              title="Bestellung beim Supplier zuruecknehmen — zurueck auf PENDING">↺ Undo</button>
                          </>
                        ) : (<>
                          {(['PENDING', 'ARRIVED', 'DELIVERED'] as const).map(st => (
                            <button
                              key={st}
                              type="button"
                              onClick={() => {
                                if (l.status === st) return;
                                try {
                                  updateOrderLineStatus(l.id, st);
                                  setLineRefresh(k => k + 1);
                                } catch (e) {
                                  alert(e instanceof Error ? e.message : String(e));
                                }
                              }}
                              style={{
                                fontSize: 10, padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
                                border: `1px solid ${l.status === st ? statusColors[st] : '#D5D9DE'}`,
                                color: l.status === st ? '#FFFFFF' : '#6B7280',
                                background: l.status === st ? statusColors[st] : 'transparent',
                              }}
                            >{st}</button>
                          ))}
                        </>)}
                      </div>
                      <div style={{ padding: '7px 0', borderTop: '1px solid #E5E9EE', display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                        {!cancelled && !l.invoiceId && !isCancelled && perm.canManageOrders && (
                          <button type="button" onClick={() => setEditLine(l)}
                            className="cursor-pointer flex items-center gap-1"
                            style={{ fontSize: 10, padding: '3px 7px', borderRadius: 4, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}
                            title="Position bearbeiten">
                            <Edit3 size={11} /> Edit
                          </button>
                        )}
                        {!cancelled && !l.invoiceId && !isCancelled && perm.canManageOrders
                          && l.status === 'PENDING' && !l.materialKind && !sourcedMap.has(l.id) && (() => {
                            const lp = l.productId ? products.find(p => p.id === l.productId) : undefined;
                            const stockQty = lp?.quantity ?? 0;
                            const noStock = !lp || stockQty <= 0;
                            // v0.6.9 — Produkt schon auf Lager: kein Bestell-Aufruf,
                            // stattdessen ein gruenes Auf-Lager-Badge. Bestellung ist
                            // optional und kann via Edit/Markieren manuell ausgeloest
                            // werden, wird aber UI-seitig nicht aktiv vorgeschlagen.
                            if (!noStock) {
                              return (
                                <span title={`Direkt aus dem Lager lieferbar (${stockQty} verfuegbar)`}
                                  style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4,
                                    background: 'rgba(22,163,74,0.10)', color: '#16A34A',
                                    border: '1px solid rgba(22,163,74,0.35)' }}>
                                  ✓ Auf Lager · {stockQty} Stk
                                </span>
                              );
                            }
                            return (
                              <button type="button"
                                onClick={() => { setMarkOrderedLine(l); setMarkOrderedSupplier(l.orderedSupplierId || ''); }}
                                className="cursor-pointer pulse-orange"
                                style={{ fontSize: 10, padding: '3px 7px', borderRadius: 4,
                                  border: '1px solid #D97706',
                                  color: '#FFFFFF',
                                  background: '#D97706' }}
                                title="Kein Bestand — beim Supplier bestellen">
                                ⚠ Beim Supplier bestellen
                              </button>
                            );
                          })()}
                        {sourcedMap.has(l.id) && (
                          <button type="button"
                            onClick={() => navigate(`/purchases/${sourcedMap.get(l.id)!.purchaseId}`)}
                            className="cursor-pointer"
                            style={{ fontSize: 10, padding: '3px 7px', borderRadius: 4,
                              border: '1px solid rgba(22,163,74,0.4)', color: '#16A34A', background: 'rgba(22,163,74,0.08)' }}
                            title="Zum verknuepften Purchase">
                            Sourced · {sourcedMap.get(l.id)!.purchaseNumber}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* v0.3.0 — Partielles Convert */}
              {!isCancelled && (() => {
                const billable = id ? getBillableLines(id) : [];
                // Noch offene customer-facing Lines (PENDING, nicht invoiced) —
                // wenn vorhanden, kann man fuers Kombinieren in EINE Invoice warten.
                const pending = customerLines.filter(l =>
                  !l.invoiceId && l.status === 'PENDING'
                ).length;
                return (
                  <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                    {/* Combine-vs-Partial Entscheidungshilfe */}
                    {billable.length > 0 && pending > 0 && (
                      <div style={{
                        marginBottom: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12,
                        background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.3)',
                        color: '#92400E',
                      }}>
                        {pending} Item(s) noch nicht fertig (PENDING).
                        {' '}Fuer EINE kombinierte Invoice warten bis alles „Arrived" ist —
                        oder die {billable.length} fertigen jetzt als Teil-Invoice converten.
                      </div>
                    )}
                    {billable.length > 0 && pending === 0 && (
                      <div style={{
                        marginBottom: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12,
                        background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(22,163,74,0.3)',
                        color: '#16A34A',
                      }}>
                        ✓ Alle Items fertig — Convert erzeugt EINE kombinierte Invoice fuer alle {billable.length}.
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span style={{ fontSize: 12, color: '#6B7280' }}>
                        {billable.length > 0
                          ? `${billable.length} item(s) bereit zum Invoicen${pending > 0 ? ` · ${pending} noch PENDING` : ''}`
                          : 'Keine fertigen Items zum Invoicen — markiere Items als „Arrived".'}
                      </span>
                      <Button
                        variant="primary"
                        onClick={handleCreateFinalInvoice}
                        disabled={billable.length === 0}
                      >
                        Convert ready items ({billable.length})
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </Card>
          </div>
        )}

        {/* v0.5.0 — Costs / Materials — Kosten nachträglich erfassen (Quote-first „cost-later") */}
        {!editing && (order.type === 'custom' || order.type === 'mixed' || costLines.length > 0) && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                <span className="text-overline">COSTS / MATERIALS ({costLines.length})</span>
                {!isCancelled && perm.canManageOrders && (
                  <Button variant="secondary" onClick={() => setShowAddCost(true)}>
                    <Plus size={14} /> Add Cost
                  </Button>
                )}
              </div>
              {costLines.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6B7280', padding: '8px 0' }}>
                  Noch keine Kosten erfasst. Trag Labor-, Diamond- &amp; Material-Kosten ein, sobald das Stück fertig
                  ist — die A/P-Schuld an den Supplier wird dabei automatisch gebucht.
                </p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '0.7fr 1.2fr 1.5fr 0.8fr 0.9fr 0.9fr 40px', gap: 10, fontSize: 12 }}>
                  <span className="text-overline">KIND</span>
                  <span className="text-overline">SUPPLIER</span>
                  <span className="text-overline">DESCRIPTION</span>
                  <span className="text-overline" style={{ textAlign: 'right' }}>COST/CT</span>
                  <span className="text-overline" style={{ textAlign: 'right' }}>COST</span>
                  <span className="text-overline">A/P</span>
                  <span />
                  {costLines.map(l => {
                    const km = COST_KIND_META[l.materialKind || 'labor'] || COST_KIND_META.product;
                    const supName = l.materialDetails?.supplierName
                      || (l.supplierId ? suppliers.find(s => s.id === l.supplierId)?.name : undefined);
                    const totalCt = (l.materialDetails?.ct || 0) * (l.materialDetails?.qty || 0);
                    const perCt = (l.materialKind === 'diamond' || l.materialKind === 'stone') && totalCt > 0
                      ? (l.costAmount || 0) / totalCt : 0;
                    // v0.6.x — Goldschmied-Gold: Kostenzeile traegt absichtlich KEINEN
                    // supplierId (die Schuld lebt als Gramm-Verbindlichkeit). Nicht als
                    // "own cost" anzeigen — das ist eine Gold-Schuld an den Goldschmied.
                    const isGoldDebt = l.materialKind === 'gold' && !l.supplierId
                      && (l.materialDetails?.weightGrams || 0) > 0 && !!l.materialDetails?.supplierName;
                    return (
                      <div key={l.id} style={{ display: 'contents' }}>
                        <span style={{ fontSize: 12, padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>{km.icon} {km.label}</span>
                        <span style={{ fontSize: 12, color: supName ? '#0F0F10' : '#9CA3AF', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          {supName || '— own cost'}
                        </span>
                        <span style={{ fontSize: 13, color: '#0F0F10', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>{l.description || '—'}</span>
                        <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          {perCt > 0 ? <Bhd v={perCt}/> : '—'}
                        </span>
                        <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          <Bhd v={l.costAmount || 0}/>
                        </span>
                        <span style={{ fontSize: 11, padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          {(() => {
                            // v0.7.7 — A/P-Chip mit Live-Status aus expenses + Klick-zum-Zahlen.
                            // OrderLine.paymentStatus existiert nicht im Type (anders als RepairLine),
                            // daher hier zur Render-Zeit aus expenses.find() ableiten.
                            if (isGoldDebt) {
                              return <span style={{ color: '#7E5BEF' }} title="Goldschmied-Gold — Gramm-Schuld, siehe Gold-Verbindlichkeiten unten">Gold-Schuld</span>;
                            }
                            if (!l.supplierId) {
                              return <span style={{ color: '#9CA3AF' }}>own cost</span>;
                            }
                            if (!l.expenseId) {
                              return <span style={{ color: '#D97706' }}>pending</span>;
                            }
                            const exp = expenses.find(e => e.id === l.expenseId);
                            const status = exp?.status;
                            const paid = exp?.paidAmount || 0;
                            const total = exp?.amount || 0;
                            if (status === 'PAID' || (total > 0 && paid >= total - 0.005)) {
                              return <span style={{ color: '#16A34A' }} title="Supplier expense fully paid">✓ Paid</span>;
                            }
                            const isPartial = paid > 0.005;
                            return (
                              <button
                                onClick={() => setPayExpenseId(l.expenseId!)}
                                className="cursor-pointer"
                                style={{
                                  background: isPartial ? 'rgba(217,119,6,0.08)' : 'rgba(15,15,16,0.04)',
                                  border: `1px solid ${isPartial ? 'rgba(217,119,6,0.4)' : '#D5D9DE'}`,
                                  color: isPartial ? '#D97706' : '#0F0F10',
                                  fontSize: 11, padding: '3px 10px', borderRadius: 4,
                                }}
                                title="Click to record payment for this supplier expense">
                                {isPartial ? 'Partial · Pay' : 'Unpaid · Pay'}
                              </button>
                            );
                          })()}
                        </span>
                        {!isCancelled && perm.canManageOrders ? (
                          <button
                            onClick={() => {
                              if (!window.confirm('Diese Kostenposition löschen? Eine gebuchte A/P-Schuld wird storniert.')) return;
                              try { deleteOrderLine(l.id); loadGoldPayables(); setLineRefresh(k => k + 1); }
                              catch (e) { alert(e instanceof Error ? e.message : String(e)); }
                            }}
                            className="cursor-pointer"
                            style={{ background: 'none', border: 'none', color: '#DC2626', borderTop: '1px solid #E5E9EE', padding: '10px 0' }}
                            title="Kostenposition löschen">
                            <Trash2 size={14} />
                          </button>
                        ) : <span style={{ borderTop: '1px solid #E5E9EE' }} />}
                      </div>
                    );
                  })}
                </div>
              )}
              {(() => {
                const totalCost = customCostBasis;
                const margin = (order.agreedPrice || 0) - totalCost;
                return (
                  <div className="flex items-center justify-between" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                    <span style={{ fontSize: 12, color: '#6B7280' }}>
                      Total Cost&nbsp;
                      <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={totalCost}/> BHD</span>
                    </span>
                    <span style={{ fontSize: 13, color: '#6B7280' }}>
                      Margin&nbsp;
                      <span className="font-mono" style={{ color: margin >= 0 ? '#16A34A' : '#DC2626' }}><Bhd v={margin}/> BHD</span>
                    </span>
                  </div>
                );
              })()}
            </Card>
          </div>
        )}

        {/* v0.6.0 — Gold-Verbindlichkeiten (Goldschmied-Gold) der Order */}
        {!editing && orderGoldPayables.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>
                GOLD-VERBINDLICHKEITEN — GOLDSCHMIED ({orderGoldPayables.length})
              </span>
              <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.9fr 0.7fr 0.9fr 1.5fr', gap: 10, fontSize: 12 }}>
                <span className="text-overline">SUPPLIER</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>OFFEN (G)</span>
                <span className="text-overline">KARAT</span>
                <span className="text-overline">STATUS</span>
                <span className="text-overline">BEGLEICHEN</span>
                {orderGoldPayables.map(gp => {
                  const supName = suppliers.find(s => s.id === gp.supplierId)?.name || gp.supplierId.slice(0, 8);
                  const remaining = Math.max(0, gp.weightGrams - gp.fulfilledGrams);
                  const open = gp.status === 'OPEN';
                  return (
                    <div key={gp.id} style={{ display: 'contents' }}>
                      <span style={{ fontSize: 13, color: '#0F0F10', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>🥇 {supName}</span>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                        {remaining.toFixed(3)} g
                      </span>
                      <span style={{ fontSize: 12, color: '#4B5563', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>{gp.karat}</span>
                      <span style={{ fontSize: 11, padding: '10px 0', borderTop: '1px solid #E5E9EE',
                        color: gp.status === 'FULFILLED' ? '#16A34A' : gp.status === 'CANCELLED' ? '#9CA3AF' : '#D97706' }}>
                        {gp.status}
                      </span>
                      <div style={{ padding: '7px 0', borderTop: '1px solid #E5E9EE', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {open && !isCancelled && perm.canManageOrders ? (
                          <>
                            <button type="button" onClick={() => setSettleGold({ mode: 'apply_shop_to_supplier', payable: gp })}
                              className="cursor-pointer"
                              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 4, border: '1px solid #C6A36D', color: '#9A7B3F', background: 'transparent' }}>
                              Gold geben
                            </button>
                            <button type="button" onClick={() => setSettleGold({ mode: 'convert_supplier_money', payable: gp })}
                              className="cursor-pointer"
                              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 4, border: '1px solid #6E8AAA', color: '#4B6A8A', background: 'transparent' }}>
                              In Geld
                            </button>
                            <button type="button"
                              onClick={() => {
                                if (!window.confirm('Gold-Verbindlichkeit löschen? Nur nutzen wenn sie versehentlich/verwaist ist — die Kostenzeile selbst bleibt unberührt.')) return;
                                try { deleteGoldPayable(gp.id); }
                                catch (e) { alert(e instanceof Error ? e.message : String(e)); }
                              }}
                              className="cursor-pointer"
                              title="Verbindlichkeit löschen (nur offene)"
                              style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '1px solid rgba(220,38,38,0.3)', color: '#DC2626', background: 'transparent' }}>
                              ✕
                            </button>
                          </>
                        ) : <span style={{ fontSize: 11, color: '#9CA3AF' }}>—</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 10 }}>
                Gold das der Goldschmied beigesteuert hat — Gramm-Schuld. „Gold geben" begleicht aus eurem Bestand, „In Geld" wandelt in einen BHD-Betrag um (A/P an den Goldschmied).
              </p>
            </Card>
          </div>
        )}

        {/* Payments Card */}
        {!editing && !isCancelled && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
                <span className="text-overline">PAYMENTS ({payments.length})</span>
                <Button variant="secondary" onClick={() => setShowPayment(true)}>
                  <Plus size={14} /> Add Payment
                </Button>
              </div>
              {payments.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6B7280', padding: '12px 0' }}>No payments recorded yet.</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) auto auto', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>DATE</span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>AMOUNT</span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>METHOD</span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>NOTE</span>
                  <span />
                  <span />
                  {payments.map(p => (
                    <div key={p.id} style={{ display: 'contents' }}>
                      <span style={{ fontSize: 13, color: '#0F0F10', paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>{p.paidAt}</span>
                      <span className="font-mono" style={{ fontSize: 13, color: '#7EAA6E', paddingTop: 10, borderTop: '1px solid #E5E9EE' }}><Bhd v={p.amount}/> BHD</span>
                      <span style={{ fontSize: 13, color: '#4B5563', paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>{p.method?.replace('_', ' ') || '\u2014'}</span>
                      <span style={{ fontSize: 12, color: '#6B7280', paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>{p.note || '\u2014'}</span>
                      <button onClick={() => handleDownloadReceipt(p)}
                        className="cursor-pointer transition-colors" style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 12, paddingTop: 10, borderTop: '1px solid #E5E9EE', display: 'flex', alignItems: 'center', gap: 4 }}
                      ><Download size={12} /> PDF</button>
                      <button onClick={() => id && deletePayment(p.id, id)}
                        className="cursor-pointer transition-colors" style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 11, paddingTop: 10, borderTop: '1px solid #E5E9EE' }}
                      >Delete</button>
                    </div>
                  ))}
                </div>
              )}
              {/* Plan §Order §Convert-to-Invoice:
                  - Convert nur bei Status=COMPLETED.
                  - Once-only: wenn invoiceId schon gesetzt → "Already converted" mit Link.
                  - linkedProduct ist Pflicht (createDirectInvoice braucht Produkt-Daten). */}
              {order.invoiceId ? (() => {
                const linkedInvoice = invoices.find(i => i.id === order.invoiceId);
                return (
                  <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(110,138,170,0.06)', borderRadius: 8, border: '1px solid rgba(110,138,170,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ fontSize: 13, color: '#4B5563' }}>
                      Already converted &mdash; <span className="font-mono" style={{ color: '#0F0F10' }}>{linkedInvoice ? formatInvoiceDisplayShort(linkedInvoice) : 'Invoice'}</span>
                    </span>
                    <Button variant="secondary" onClick={() => navigate(`/invoices/${order.invoiceId}`)}>See Invoice</Button>
                  </div>
                );
              })() : isCompleted && perm.canManageOrders && (
                <div style={{ marginTop: 16, padding: '12px 14px', background: 'rgba(126,170,110,0.06)', borderRadius: 8, border: '1px solid rgba(126,170,110,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 13, color: '#7EAA6E' }}>
                    {linkedProduct
                      ? 'Order completed. Create the final invoice.'
                      : 'Order completed. A product entry will be created automatically with the invoice.'}
                  </span>
                  <Button variant="primary" onClick={handleCreateFinalInvoice}>Create Invoice</Button>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Status Timeline */}
        {!editing && (
          <div style={{ marginTop: 32 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>STATUS TIMELINE</span>
              <div className="flex items-center gap-0" style={{ marginTop: 20, overflowX: 'auto' }}>
                {STATUS_FLOW.map((s, i) => {
                  const currentIdx = STATUS_FLOW.indexOf(order.status);
                  const isPast = i <= currentIdx;
                  const isCurrent = s === order.status;
                  return (
                    <div key={s} className="flex items-center" style={{ flex: 1 }}>
                      <div className="flex flex-col items-center" style={{ flex: 1 }}>
                        <div
                          className="rounded-full flex items-center justify-center"
                          style={{
                            width: isCurrent ? 28 : 20,
                            height: isCurrent ? 28 : 20,
                            background: isPast ? (isCurrent ? '#0F0F10' : 'rgba(15,15,16,0.15)') : '#E5E9EE',
                            border: `2px solid ${isPast ? '#0F0F10' : '#D5D9DE'}`,
                            transition: 'all 0.3s ease',
                          }}
                        >
                          {isPast && !isCurrent && (
                            <span style={{ fontSize: 10, color: '#0F0F10' }}>&#10003;</span>
                          )}
                        </div>
                        <span style={{
                          fontSize: 10,
                          color: isCurrent ? '#0F0F10' : isPast ? '#4B5563' : '#6B7280',
                          marginTop: 6,
                          textAlign: 'center',
                          fontWeight: isCurrent ? 600 : 400,
                          whiteSpace: 'nowrap',
                        }}>
                          {statusLabel(s)}
                        </span>
                      </div>
                      {i < STATUS_FLOW.length - 1 && (
                        <div style={{
                          height: 2,
                          flex: 1,
                          minWidth: 24,
                          background: i < currentIdx ? '#0F0F10' : '#E5E9EE',
                          marginTop: -16,
                        }} />
                      )}
                    </div>
                  );
                })}
              </div>
              {isCancelled && (
                <div className="flex items-center gap-2" style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(170,110,110,0.06)', borderRadius: 8, border: '1px solid rgba(170,110,110,0.15)' }}>
                  <StatusDot status="cancelled" />
                  <span style={{ fontSize: 13, color: '#AA6E6E' }}>This order has been cancelled</span>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {/* Add Payment Modal */}
      <Modal open={showPayment} onClose={() => setShowPayment(false)} title="Add Payment" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input required label="AMOUNT (BHD)" type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} autoFocus />
            <Input required label="PAYMENT DATE" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {['cash', 'bank_transfer', 'card', 'benefit', 'cheque'].map(m => (
                <button key={m} onClick={() => setPayMethod(m)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '6px 12px', fontSize: 12,
                    border: `1px solid ${payMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: payMethod === m ? '#0F0F10' : '#6B7280',
                    background: payMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</button>
              ))}
            </div>
            {/* v0.7.26 — Karten-Brand bei Card-Zahlung (Normal 2,2% / Amex 2,5%). */}
            {payMethod === 'card' && (
              <div className="flex gap-2" style={{ marginTop: 10 }}>
                {(['normal', 'amex'] as const).map(b => {
                  const on = payCardBrand === b;
                  return (
                    <button key={b} type="button" onClick={() => setPayCardBrand(b)}
                      className="cursor-pointer rounded"
                      style={{ padding: '6px 12px', fontSize: 12,
                        border: `1px solid ${on ? '#0F0F10' : '#D5D9DE'}`,
                        color: on ? '#0F0F10' : '#6B7280',
                        background: on ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{b === 'amex' ? 'Amex' : 'Normal'}</button>
                  );
                })}
              </div>
            )}
          </div>
          <Input label="NOTE (optional)" value={payNote} onChange={e => setPayNote(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowPayment(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleAddPayment} disabled={!payAmount}>Save Payment</Button>
          </div>
        </div>
      </Modal>

      {/* v0.5.0 — Add Cost: shared Material-Modal (Labor + Diamond/Stone/Gold, Cost/Carat) */}
      <AddMaterialModal
        open={showAddCost}
        onClose={() => setShowAddCost(false)}
        onSubmit={handleAddCostMaterial}
        showCustomerPrice={false}
        allowLabor={true}
      />

      {/* Back-to-Back — Order-Position bearbeiten */}
      <OrderLineEditModal
        open={!!editLine}
        line={editLine}
        productLocked={!!(editLine && sourcedMap.has(editLine.id))}
        onClose={() => setEditLine(null)}
        onSave={handleSaveOrderLine}
      />

      {/* Back-to-Back — Wareneingang erfassen (Posten-Auswahl, gruppiert nach Supplier) */}
      <SourceItemsModal
        open={sourceModalOpen}
        orderId={id || ''}
        lines={sourceCandidates}
        onClose={() => { setSourceModalOpen(false); setLineRefresh(k => k + 1); }}
      />

      {/* Back-to-Back — "Beim Supplier bestellt" markieren (Supplier festhalten) */}
      <Modal open={!!markOrderedLine} onClose={() => setMarkOrderedLine(null)}
        title="Beim Supplier bestellt" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 12, color: '#6B7280' }}>
            Markiert „{markOrderedLine?.description}" als beim Supplier bestellt. Waehle den
            Supplier — der Wareneingang gruppiert die Posten danach. Den Wareneingang
            (Kosten + Lager) erfasst du spaeter als Purchase.
          </p>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>SUPPLIER (OPTIONAL)</span>
            <SearchSelect
              placeholder="Supplier waehlen — oder leer lassen"
              options={suppliers.filter(s => s.active).map(s => ({ id: s.id, label: s.name, subtitle: s.phone || '' }))}
              value={markOrderedSupplier}
              onChange={setMarkOrderedSupplier}
            />
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setMarkOrderedLine(null)}>Abbrechen</Button>
            <Button variant="primary" onClick={() => {
              if (!markOrderedLine) return;
              try {
                markOrderLineOrdered(markOrderedLine.id, markOrderedSupplier || undefined);
                setMarkOrderedLine(null);
                setLineRefresh(k => k + 1);
              } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
            }}>Bestellt markieren</Button>
          </div>
        </div>
      </Modal>

      {/* v0.6.0 — Gold-Verbindlichkeit begleichen (Gold geben / in Geld umwandeln) */}
      {settleGold && (
        <SettleGoldModal
          open={true}
          mode={settleGold.mode}
          payable={settleGold.payable}
          onClose={() => { setSettleGold(null); loadGoldPayables(); }}
        />
      )}

      {/* v0.7.7 — Pay-Expense Modal aus A/P-Chip-Klick. recordExpensePayment
          triggert Cross-Store-Reload, der lineRefresh-Tick bumpt nach Submit
          damit der Chip live auf "✓ Paid" flippt. */}
      <PayExpenseModal
        expenseId={payExpenseId}
        onClose={() => setPayExpenseId(null)}
        onPaid={() => setLineRefresh(k => k + 1)}
      />

      {customer && (
        <MessagePreviewModal
          open={showMessage}
          onClose={() => setShowMessage(false)}
          type="order_arrived"
          customerId={customer.id}
          customerName={`${customer.firstName} ${customer.lastName}`}
          customerPhone={customer.phone}
          customerWhatsapp={customer.whatsapp}
          productImage={linkedProduct?.images?.[0]}
          productLabel={`${order.requestedBrand} ${order.requestedModel}`.trim()}
          details={`Order ${order.orderNumber} has arrived.${remaining > 0 ? ` Remaining amount: ${remaining} BHD.` : ''}`}
          linkedEntityType="order"
          linkedEntityId={order.id}
        />
      )}

      {/* Confirm Status Advance Modal */}
      <Modal open={!!confirmAdvance} onClose={() => setConfirmAdvance(null)} title="Advance Status" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Advance order <strong style={{ color: '#0F0F10' }}>{order.orderNumber}</strong> to <strong style={{ color: '#0F0F10' }}>{confirmAdvance ? statusLabel(confirmAdvance) : ''}</strong>?
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmAdvance(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => confirmAdvance && handleAdvance(confirmAdvance)}>Confirm</Button>
        </div>
      </Modal>

      {/* v0.7.0 — Cancel-Wizard mit Geld-Handling + Auto-Lifecycle-Info */}
      <CancelOrderModal
        open={confirmCancel}
        order={order}
        orderLines={orderLineList}
        totalPaid={totalPaid}
        sourcedLineIds={new Set(sourcedMap.keys())}
        openGoldPayableCount={orderGoldPayables.filter(gp => gp.status === 'OPEN').length}
        onCancel={() => { setConfirmCancel(false); setPendingHardDelete(false); }}
        onConfirm={(choice, refundMethod) => handleCancel(choice, refundMethod)}
      />

      {/* Convert-to-Invoice VAT-Scheme Picker */}
      <ConfirmTaxSchemeModal
        open={showInvoiceVatConfirm}
        lines={productForConvert ? [{
          id: productForConvert.id,
          label: `${productForConvert.brand || ''} ${productForConvert.name || ''}`.trim() || 'Custom Item',
          currentScheme: (productForConvert.taxScheme as TaxScheme) || 'MARGIN',
        }] : []}
        onCancel={() => setShowInvoiceVatConfirm(false)}
        onConfirm={handleConfirmFinalInvoice}
        title="Create Final Invoice"
      />

      {/* v0.6.7 — VAT-Picker fuer persistierte Multi-Line-Orders (inkl. Custom-Quote). */}
      <ConfirmTaxSchemeModal
        open={showPersistedVatConfirm}
        lines={pendingBillable.map(l => ({
          id: l.id,
          label: l.description || (l.materialKind === 'custom' ? 'Custom Item' : 'Item'),
          currentScheme: (l.taxScheme as TaxScheme) || 'MARGIN',
        }))}
        onCancel={() => { setShowPersistedVatConfirm(false); setPendingBillable([]); }}
        onConfirm={(perLine) => {
          const billable = pendingBillable;
          setShowPersistedVatConfirm(false);
          setPendingBillable([]);
          setPendingNumberAction(() => async (special: boolean) => convertWithPersistedSchemes(billable, special, perLine));
        }}
        title="VAT-Schema bestaetigen"
        confirmLabel="Weiter"
      />

      <NumberTypeDialog
        open={!!pendingNumberAction}
        variant="sales"
        onCancel={() => setPendingNumberAction(null)}
        onConfirm={(special) => {
          const act = pendingNumberAction;
          setPendingNumberAction(null);
          if (act) void act(special);
        }}
      />

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Order" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete <strong style={{ color: '#0F0F10' }}>{order.orderNumber}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="orders"
        entityId={order.id}
        title={`History · ${order.orderNumber}`}
      />
    </div>
  );
}
