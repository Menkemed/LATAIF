import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft, Edit3, Save, FileText, XCircle, CreditCard, Printer, Download, Table, Plus, Trash2, ExternalLink } from 'lucide-react';

// Butterfly icon as inline SVG — renders reliably in all webviews (no emoji font dependency).
const Butterfly = ({ size = 14, style }: { size?: number; style?: React.CSSProperties }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline-block', verticalAlign: '-0.125em', ...style }} aria-hidden="true">
    <path d="M12 8c-.5-2-2.2-4-5-4-2.5 0-4.5 2-4.5 4.5 0 1.4.6 2.6 1.6 3.4C2.6 12.5 2 13.6 2 15c0 2.5 2 4.5 4.5 4.5 3 0 4.8-2.3 5.5-4.5.7 2.2 2.5 4.5 5.5 4.5 2.5 0 4.5-2 4.5-4.5 0-1.4-.6-2.5-1.6-3.1 1-.8 1.6-2 1.6-3.4C22 6 20 4 17.5 4c-2.8 0-4.5 2-5 4zm-.5 2v8.5c0 .3-.2.5-.5.5s-.5-.2-.5-.5V10c0-.3.2-.5.5-.5s.5.2.5.5zm1.5 0v8.5c0 .3-.2.5-.5.5s-.5-.2-.5-.5V10c0-.3.2-.5.5-.5s.5.2.5.5zM9.5 5.5c.3 0 .5.2.5.5s-.2.5-.5.5-.5-.2-.5-.5.2-.5.5-.5zm5 0c.3 0 .5.2.5.5s-.2.5-.5.5-.5-.2-.5-.5.2-.5.5-.5z"/>
  </svg>
);
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useRepairStore } from '@/stores/repairStore';
import type { PaymentMethod } from '@/core/models/types';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { formatProductMultiLine, getProductSpecs } from '@/core/utils/product-format';
import { usePermission } from '@/hooks/usePermission';
import logoUrl from '@/assets/logo.png';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useCreditNoteStore } from '@/stores/creditNoteStore';
import { exportCsv } from '@/core/utils/export-file';
import type { ProductDisposition } from '@/core/models/types';
import { RotateCcw } from 'lucide-react';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso?: string): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'crypto', label: 'Crypto' },
];

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { invoices, loadInvoices, updateInvoice, rewriteInvoiceLines, recordPayment, getInvoicePayments, updatePayment, deletePayment, deleteInvoice } = useInvoiceStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const { repairs, loadRepairs, updateStatus: updateRepairStatus } = useRepairStore();
  const perm = usePermission();

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editNotes, setEditNotes] = useState('');
  const [editDueAt, setEditDueAt] = useState('');
  const [editIssuedAt, setEditIssuedAt] = useState('');
  const [editCustomerId, setEditCustomerId] = useState('');

  // Lines-Edit Modal
  const [linesModal, setLinesModal] = useState(false);
  const [lineDraft, setLineDraft] = useState<Array<{ id?: string; productId: string; description: string; quantity: number; unitPrice: number; purchasePrice: number; vatRate: number; vatAmount: number; lineTotal: number; taxScheme: string }>>([]);
  const [productPickerIdx, setProductPickerIdx] = useState<number | null>(null);
  const [productPickerQuery, setProductPickerQuery] = useState('');

  // Payments-Manage Modal
  const [paymentsModal, setPaymentsModal] = useState(false);

  // Sales Return state
  const { returns: salesReturns, loadReturns: loadSalesReturns, createReturn: createSalesReturn, refundReturn: refundSalesReturn,
    getInvoiceReturnSummary, recordRefundPayment, getReturnedQtyForLine } = useSalesReturnStore();
  const { creditNotes, loadCreditNotes } = useCreditNoteStore();
  const [showReturn, setShowReturn] = useState(false);
  const [returnLines, setReturnLines] = useState<Record<string, { include: boolean; quantity: number; unitPrice: number }>>({});
  const [returnRefundMethod, setReturnRefundMethod] = useState<'cash' | 'bank' | 'card' | 'credit' | 'other'>('bank');
  const [returnDisposition, setReturnDisposition] = useState<ProductDisposition>('IN_STOCK');
  const [returnNotes, setReturnNotes] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [returnRefundNow, setReturnRefundNow] = useState(true); // Toggle: Refund sofort oder offen lassen

  // Plan §Returns Fix — Refund-Payment-Modal statt window.prompt()
  const [refundPayModal, setRefundPayModal] = useState<{ returnId: string; outstanding: number } | null>(null);
  const [refundPayAmount, setRefundPayAmount] = useState('');
  const [refundPayMethod, setRefundPayMethod] = useState<'cash' | 'bank' | 'card' | 'credit' | 'other'>('bank');

  // Payment modal
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('bank_transfer');

  // Cancel confirm
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelRefundMethod, setCancelRefundMethod] = useState<'cash' | 'bank'>('bank');

  useEffect(() => { loadInvoices(); loadCustomers(); loadProducts(); loadCategories(); loadSalesReturns(); loadCreditNotes(); loadRepairs(); }, [loadInvoices, loadCustomers, loadProducts, loadCategories, loadSalesReturns, loadCreditNotes, loadRepairs]);

  // Derived status label — industry-standard naming (SAP/Xero/QuickBooks):
  // CANCELLED → Cancelled
  // DRAFT → Pending
  // gross-credits = 0 → Cancelled (fully credited)
  // paid >= gross-credits → Paid
  // paid > 0 → Partially Paid
  // paid = 0 → Unpaid
  function derivedInvoiceLabel(inv: { status: string; grossAmount: number; paidAmount: number; id: string }): string {
    if (inv.status === 'CANCELLED') return 'Cancelled';
    if (inv.status === 'DRAFT') return 'Pending';
    const credited = (creditNotes || []).filter(cn => cn.invoiceId === inv.id).reduce((s, cn) => s + (cn.totalAmount || 0), 0);
    const effGross = Math.max(0, inv.grossAmount - credited);
    if (effGross < 0.01 && credited > 0) return 'Credited';
    if (inv.paidAmount >= effGross - 0.01) return 'Paid';
    if (inv.paidAmount > 0) return 'Partially Paid';
    return 'Unpaid';
  }

  const invoice = useMemo(() => invoices.find(i => i.id === id), [invoices, id]);

  // Plan §Sales — Save & Print: Detail-Page lädt, dann Print-Dialog automatisch öffnen.
  useEffect(() => {
    if (invoice && searchParams.get('print') === '1') {
      setSearchParams({}, { replace: true });
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [invoice, searchParams, setSearchParams]);
  const customer = useMemo(() => invoice ? customers.find(c => c.id === invoice.customerId) : null, [invoice, customers]);

  useEffect(() => {
    if (invoice) {
      setEditNotes(invoice.notes || '');
      setEditDueAt(invoice.dueAt || '');
      setEditIssuedAt((invoice.issuedAt || invoice.createdAt || '').split('T')[0]);
      setEditCustomerId(invoice.customerId);
    }
  }, [invoice]);

  if (!invoice) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Invoice not found</p>
      </div>
    );
  }

  // Industry-Standard: Outstanding berücksichtigt Credit Notes — was per CN storniert wurde
  // ist keine Forderung mehr.
  const creditedTotal = (creditNotes || []).filter(cn => cn.invoiceId === invoice.id).reduce((s, cn) => s + (cn.totalAmount || 0), 0);
  const effectiveGross = Math.max(0, invoice.grossAmount - creditedTotal);
  const remaining = Math.max(0, effectiveGross - invoice.paidAmount);
  const isDraft = invoice.status === 'DRAFT';
  const isCancelled = invoice.status === 'CANCELLED';
  const isPaid = invoice.status === 'FINAL';
  const canRecordPayment = !isDraft && !isCancelled && !isPaid;
  const canCancel = !isCancelled && !isPaid;

  // Plan §Repair §Pickup-from-Invoice (User-Spec): wenn diese Invoice an Repairs
  // gekoppelt ist (auch eine Bulk-Invoice mit mehreren), voll bezahlt + mind. einer
  // noch nicht abgeholt → "Mark as Picked Up"-Button setzt ALLE verbundenen Repairs
  // gleichzeitig auf picked_up — Repair-Dashboard sieht das automatisch (gleicher Store).
  const linkedRepairs = useMemo(
    () => repairs.filter(r => r.invoiceId === invoice.id),
    [repairs, invoice.id],
  );
  const pendingRepairs = useMemo(
    () => linkedRepairs.filter(r => r.status !== 'picked_up' && r.status !== 'cancelled' && r.status !== 'returned' && r.status !== 'CANCELLED' && r.status !== 'DELIVERED'),
    [linkedRepairs],
  );
  const canMarkRepairPickedUp = pendingRepairs.length > 0 && isPaid;

  function handleSaveEdit() {
    if (!id) return;
    updateInvoice(id, {
      notes: editNotes,
      dueAt: editDueAt,
      issuedAt: editIssuedAt,
      customerId: editCustomerId,
    });
    setEditing(false);
  }

  function openLinesEdit() {
    if (!invoice) return;
    setLineDraft(invoice.lines.map(l => ({
      id: l.id,
      productId: l.productId,
      description: l.description || '',
      quantity: Math.max(1, l.quantity || 1),
      unitPrice: l.unitPrice,
      purchasePrice: l.purchasePriceSnapshot,
      vatRate: l.vatRate,
      vatAmount: l.vatAmount,
      lineTotal: l.lineTotal,
      taxScheme: l.taxScheme,
    })));
    setLinesModal(true);
  }

  function recalcLine(idx: number, patch: Partial<typeof lineDraft[number]>) {
    setLineDraft(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const merged = { ...l, ...patch };
      const rate = Number(merged.vatRate) || 0;
      const net = Number(merged.unitPrice) || 0;
      const qty = Math.max(1, Number(merged.quantity) || 1);
      // VAT pro Einheit; lineTotal = qty × (net + vat) für VAT_10, qty × net für MARGIN/ZERO
      if (merged.taxScheme === 'VAT_10') {
        merged.vatAmount = Math.round(net * (rate / 100) * 1000) / 1000;
        merged.lineTotal = (net + merged.vatAmount) * qty;
      } else if (merged.taxScheme === 'MARGIN') {
        const margin = Math.max(0, net - (Number(merged.purchasePrice) || 0));
        merged.vatAmount = Math.round(margin * (rate / (100 + rate)) * 1000) / 1000;
        merged.lineTotal = net * qty;
      } else {
        merged.vatAmount = 0;
        merged.lineTotal = net * qty;
      }
      return merged;
    }));
  }

  function addLine() {
    setLineDraft(prev => [...prev, {
      productId: products[0]?.id || '',
      description: '',
      quantity: 1,
      unitPrice: 0,
      purchasePrice: 0,
      vatRate: 10,
      vatAmount: 0,
      lineTotal: 0,
      taxScheme: 'MARGIN',
    }]);
  }

  function pickProductForLine(idx: number, productId: string) {
    const p = products.find(pp => pp.id === productId);
    if (!p) return;
    recalcLine(idx, {
      productId,
      unitPrice: p.plannedSalePrice ?? p.lastSalePrice ?? p.purchasePrice ?? 0,
      purchasePrice: p.purchasePrice ?? 0,
      taxScheme: p.taxScheme || 'MARGIN',
    });
    setProductPickerIdx(null);
    setProductPickerQuery('');
  }

  function saveLines() {
    if (!id || lineDraft.length === 0) return;
    rewriteInvoiceLines(id, lineDraft.map(l => ({
      productId: l.productId,
      quantity: Math.max(1, Number(l.quantity) || 1),
      unitPrice: Number(l.unitPrice) || 0,
      purchasePrice: Number(l.purchasePrice) || 0,
      taxScheme: l.taxScheme,
      vatRate: Number(l.vatRate) || 0,
      vatAmount: Number(l.vatAmount) || 0,
      lineTotal: Number(l.lineTotal) || 0,
      description: l.description || undefined,
    })));
    setLinesModal(false);
  }

  function handleCancelInvoice() {
    if (!id || !invoice) return;
    // Plan §Sales §14: Cancel PARTIAL → Status=CANCELLED + Refund (if paid) + Produkte freigeben.
    if (invoice.paidAmount > 0) {
      try {
        const ret = useSalesReturnStore.getState().createReturn({
          invoiceId: id,
          refundMethod: cancelRefundMethod,
          productDisposition: 'IN_STOCK',
          notes: `Auto-refund on invoice cancellation (${invoice.invoiceNumber})`,
          lines: invoice.lines.map(l => ({
            invoiceLineId: l.id,
            productId: l.productId,
            quantity: 1,
            unitPrice: l.unitPrice,
            vatAmount: l.vatAmount,
          })),
        });
        // Refund tatsächlich durchführen — approve + refund → Cash/Bank -= refundAmount
        useSalesReturnStore.getState().approveReturn(ret.id);
        useSalesReturnStore.getState().refundReturn(ret.id);
      } catch (e) {
        console.warn('Cancel-refund failed, continuing with status change:', e);
      }
    } else {
      // Plan §Sales §14: Produkt wieder freigeben. Kein Geld erhalten → nur Stock-Release.
      // Quantity-aware: pro Line wird 1 Stück zurück ins Lager gebucht.
      const ps = useProductStore.getState();
      for (const l of invoice.lines) {
        try {
          const p = ps.getProduct(l.productId);
          if (p) {
            ps.updateProduct(l.productId, {
              quantity: (p.quantity || 0) + 1,
              stockStatus: 'in_stock',
            });
          }
        } catch { /* */ }
      }
    }
    updateInvoice(id, { status: 'CANCELLED' });
    setConfirmCancel(false);
  }

  function handleDeleteInvoice() {
    if (!id) return;
    deleteInvoice(id);
    navigate('/invoices');
  }

  function openReturnModal() {
    if (!invoice) return;
    const init: Record<string, { include: boolean; quantity: number; unitPrice: number }> = {};
    for (const l of invoice.lines) {
      // Gross-Unit-Preis (inkl. VAT) als Default — was der Kunde tatsächlich pro Stück gezahlt hat.
      const grossUnit = l.lineTotal / Math.max(1, l.quantity);
      // Default-Qty = noch verbleibende returnfähige Menge nach Abzug bereits zurückgegebener.
      const alreadyReturned = getReturnedQtyForLine(l.id);
      const remainingQty = Math.max(0, l.quantity - alreadyReturned);
      init[l.id] = { include: false, quantity: remainingQty, unitPrice: grossUnit };
    }
    setReturnLines(init);
    setReturnDisposition('IN_STOCK');
    setReturnRefundMethod('bank');
    setReturnNotes('');
    setReturnReason('');
    setReturnRefundNow(true);
    setShowReturn(true);
  }

  function handleCreateSalesReturn() {
    if (!id || !invoice) return;
    const included = invoice.lines
      .filter(l => returnLines[l.id]?.include)
      .map(l => {
        const rl = returnLines[l.id];
        // unitPrice ist jetzt GROSS (inkl. VAT). VAT-Anteil proportional zum zurückgegebenen
        // Wert berechnen — funktioniert für VAT_10 + MARGIN identisch.
        const returnedTotal = rl.quantity * rl.unitPrice;
        const origTotal = l.lineTotal || 0;
        const vatAmount = origTotal > 0 ? (l.vatAmount * returnedTotal) / origTotal : 0;
        return {
          invoiceLineId: l.id,
          productId: l.productId,
          quantity: rl.quantity,
          unitPrice: rl.unitPrice,
          vatAmount,
        };
      });
    if (included.length === 0) {
      alert('Bitte mindestens eine Position über die Checkbox auswählen.');
      return;
    }
    try {
      const ret = createSalesReturn({
        invoiceId: id,
        refundMethod: returnRefundMethod,
        productDisposition: returnDisposition,
        reason: returnReason || undefined,
        notes: returnNotes || undefined,
        lines: included,
      });
      // Plan §Returns: Refund optional sofort durchführen oder offen lassen.
      if (returnRefundNow) {
        refundSalesReturn(ret.id);
      }
      // Invoice-Store reloaden damit paid_amount/Status nach Refund frisch sind.
      loadInvoices();
      setShowReturn(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Return] failed:', e);
      alert(`Return konnte nicht angelegt werden:\n\n${msg}`);
    }
  }

  function handleRecordPayment() {
    if (!id) return;
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) return;
    recordPayment(id, amount, paymentMethod);
    setPaymentOpen(false);
    setPaymentAmount('');
    setPaymentMethod('bank_transfer');
  }

  // Customer-facing PDF — no margin VAT visible
  function handleDownloadPdf() {
    if (!invoice) return;
    const stdLines = invoice.lines.filter(l => l.taxScheme === 'VAT_10');
    const stdVat = stdLines.reduce((s, l) => s + l.vatAmount, 0);

    // Plan §Print — Volle Specs (Brand+Name+alle Attribute) statt nur Name.
    const lines = invoice.lines.map(l => {
      const product = products.find(p => p.id === l.productId);
      const fullDesc = formatProductMultiLine(product, categories);
      const headWithVat = l.taxScheme === 'MARGIN'
        ? fullDesc
        : `${fullDesc}\n(incl. VAT ${fmt(l.vatAmount)} BHD)`;
      return { label: headWithVat || getProductName(l.productId), value: `${fmt(l.lineTotal)} BHD` };
    });

    const summaryLines: { label: string; value: string; bold?: boolean }[] = [];
    if (stdVat > 0) {
      summaryLines.push({ label: 'VAT (10%)', value: `${fmt(stdVat)} BHD` });
    }
    summaryLines.push({ label: 'Total', value: `${fmt(invoice.grossAmount)} BHD`, bold: true });
    if (invoice.paidAmount > 0) summaryLines.push({ label: 'Paid', value: `${fmt(invoice.paidAmount)} BHD` });
    if (remaining > 0) summaryLines.push({ label: 'Due', value: `${fmt(remaining)} BHD`, bold: true });

    downloadPdf({
      title: invoice.invoiceNumber,
      number: invoice.invoiceNumber,
      date: fmtDate(invoice.issuedAt || invoice.createdAt),
      subtitle: `Due: ${fmtDate(invoice.dueAt)}`,
      customer: customer ? { name: `${customer.firstName} ${customer.lastName}`, company: customer.company, phone: customer.phone } : undefined,
      type: 'invoice',
      sections: [
        { title: 'Items', lines },
        { title: 'Summary', lines: summaryLines },
      ],
      footer: 'Thank you for your business.',
    });
  }

  // Internal VAT export as CSV (for NBR tax reporting)
  function handleExportVat() {
    if (!invoice) return;
    const header = 'Invoice,Date,Product,Tax Scheme,Unit Price (Net),Purchase Price,Margin,VAT Rate,VAT Amount,Line Total';
    const rows = invoice.lines.map(l => {
      const margin = l.taxScheme === 'MARGIN' ? l.unitPrice - l.purchasePriceSnapshot : 0;
      return [
        invoice.invoiceNumber,
        fmtDate(invoice.issuedAt || invoice.createdAt),
        getProductName(l.productId).replace(/,/g, ' '),
        l.taxScheme,
        l.unitPrice.toFixed(3),
        l.purchasePriceSnapshot.toFixed(3),
        margin.toFixed(3),
        l.vatRate,
        l.vatAmount.toFixed(3),
        l.lineTotal.toFixed(3),
      ].join(',');
    });

    // Summary rows
    const marginVat = invoice.lines.filter(l => l.taxScheme === 'MARGIN').reduce((s, l) => s + l.vatAmount, 0);
    const stdVat = invoice.lines.filter(l => l.taxScheme === 'VAT_10').reduce((s, l) => s + l.vatAmount, 0);
    rows.push('');
    rows.push(`,,,,,,,,Total VAT,${invoice.vatAmount.toFixed(3)}`);
    if (marginVat > 0) rows.push(`,,,,,,,,Margin Scheme VAT,${marginVat.toFixed(3)}`);
    if (stdVat > 0) rows.push(`,,,,,,,,Standard VAT,${stdVat.toFixed(3)}`);
    rows.push(`,,,,,,,,Net Revenue,${invoice.netAmount.toFixed(3)}`);
    rows.push(`,,,,,,,,Gross Revenue,${invoice.grossAmount.toFixed(3)}`);

    const csv = [header, ...rows].join('\n');
    exportCsv(`${invoice.invoiceNumber}_VAT.csv`, csv);
  }

  function openPaymentModal() {
    setPaymentAmount(String(remaining > 0 ? remaining.toFixed(2) : ''));
    setPaymentOpen(true);
  }

  function getProductName(productId: string): string {
    const p = products.find(pr => pr.id === productId);
    if (!p) return productId;
    return p.brand ? `${p.brand} ${p.name}` : p.name;
  }

  function renderField(label: string, value: React.ReactNode) {
    return (
      <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
        <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
        <span style={{ fontSize: 13, color: '#0F0F10' }}>{value || '\u2014'}</span>
      </div>
    );
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/invoices')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Invoices
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setEditNotes(invoice.notes || ''); setEditDueAt(invoice.dueAt || ''); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSaveEdit}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                {perm.canEditInvoices && !isCancelled && <Button variant="secondary" onClick={() => navigate(`/invoices/${invoice.id}/edit`)}><Edit3 size={14} /> Edit</Button>}
                {perm.canEditInvoices && !isCancelled && (
                  <Button
                    variant={invoice.butterfly ? 'primary' : 'ghost'}
                    onClick={() => updateInvoice(invoice.id, { butterfly: !invoice.butterfly })}
                    title={invoice.butterfly ? 'Butterfly flag active — excluded from NBR export by default' : 'Flag as Butterfly (exclude from NBR export)'}
                  >
                    <Butterfly size={14} /> Butterfly{invoice.butterfly ? ' ✓' : ''}
                  </Button>
                )}
                <Button variant="secondary" onClick={handleDownloadPdf}><Download size={14} /> PDF</Button>
                <Button variant="secondary" onClick={() => window.print()} className="no-print"><Printer size={14} /> Print</Button>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                {perm.canExportData && <Button variant="ghost" onClick={handleExportVat}><Table size={14} /> VAT Export</Button>}
                {canRecordPayment && perm.canRecordPayments && <Button variant="primary" onClick={openPaymentModal}><CreditCard size={14} /> Record Payment</Button>}
                {canMarkRepairPickedUp && (
                  <Button variant="primary" onClick={() => {
                    const refs = pendingRepairs.map(r => r.repairNumber).join(', ');
                    const msg = pendingRepairs.length === 1
                      ? `Mark repair ${refs} as picked up?`
                      : `Mark all ${pendingRepairs.length} linked repairs as picked up? (${refs})`;
                    if (!window.confirm(msg)) return;
                    try {
                      for (const r of pendingRepairs) {
                        updateRepairStatus(r.id, 'picked_up');
                      }
                    } catch (err) {
                      alert(err instanceof Error ? err.message : String(err));
                    }
                  }}>
                    <ExternalLink size={14} /> Mark as Picked Up
                    {pendingRepairs.length > 1 ? ` (${pendingRepairs.length})` : ''}
                  </Button>
                )}
                {(() => {
                  // Plan §Returns Fix: Create Return erlauben auch bei PARTIAL (nicht nur FINAL).
                  // Blockieren wenn bereits voll zurückgegeben UND voll erstattet, oder wenn CANCELLED.
                  const sum = getInvoiceReturnSummary(invoice.id, invoice.grossAmount, invoice.paidAmount);
                  const fullyDone = sum.returnState === 'RETURNED' && sum.refundState === 'REFUNDED';
                  const canCreate = !isCancelled && !fullyDone && (invoice.status === 'FINAL' || invoice.status === 'PARTIAL');
                  if (!canCreate) return null;
                  return <Button variant="secondary" onClick={openReturnModal}><RotateCcw size={14} /> Create Return</Button>;
                })()}
                {canCancel && perm.canEditInvoices && <Button variant="danger" onClick={() => setConfirmCancel(true)}><XCircle size={14} /> Cancel</Button>}
                {perm.canDeleteInvoices && !isPaid && <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>}
              </>
            )}
          </div>
        </div>

        {editing && !isDraft && (
          <div style={{ marginBottom: 24, padding: '12px 16px', background: 'rgba(170,149,110,0.08)', border: '1px solid rgba(170,149,110,0.3)', borderRadius: 8 }}>
            <span style={{ fontSize: 13, color: '#AA956E', fontWeight: 500 }}>Admin edit mode</span>
            <p style={{ fontSize: 12, color: '#4B5563', marginTop: 4, lineHeight: 1.5 }}>
              You are editing an {invoice.status === 'FINAL' ? 'already-paid' : invoice.status} invoice. Alle Änderungen werden im History-Log getrackt (User, Zeit, Old/New).
            </p>
          </div>
        )}

        {/* Edit Header — Customer + Issued Date + Due Date + Status-Override */}
        {editing && (
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>HEADER FIELDS</span>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 16, marginTop: 12 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CUSTOMER</span>
                <select value={editCustomerId}
                  onChange={e => setEditCustomerId(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF', color: '#0F0F10' }}>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.firstName} {c.lastName}{c.company ? ` — ${c.company}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <Input required label="ISSUED DATE" type="date" value={editIssuedAt}
                onChange={e => setEditIssuedAt(e.target.value)} />
              <Input required label="DUE DATE" type="date" value={editDueAt}
                onChange={e => setEditDueAt(e.target.value)} />
            </div>
            {/* Manueller Status-Override (Plan §Sales §13) */}
            <div style={{ marginTop: 16 }}>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>STATUS OVERRIDE</span>
              <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
                {(['DRAFT', 'PARTIAL', 'FINAL', 'CANCELLED'] as const).map(s => {
                  const active = invoice.status === s;
                  return (
                    <button key={s}
                      onClick={() => {
                        if (!id) return;
                        // FINAL ist nur erlaubt wenn paid >= gross — sonst Revenue-Verfälschung.
                        if (s === 'FINAL' && invoice.paidAmount < invoice.grossAmount - 0.005) {
                          alert(`Status FINAL nicht möglich: Outstanding ${(invoice.grossAmount - invoice.paidAmount).toFixed(3)} BHD. Zuerst Zahlung erfassen.`);
                          return;
                        }
                        // PARTIAL braucht zumindest paid > 0.
                        if (s === 'PARTIAL' && invoice.paidAmount <= 0) {
                          alert('Status PARTIAL nicht möglich: keine Zahlung erfasst. Wähle DRAFT oder erfasse eine Zahlung.');
                          return;
                        }
                        // CANCELLED auf bezahlter Invoice → paid_amount > 0 + CANCELLED ist Cashflow-Inkonsistenz.
                        // Erst Refund/Return durchführen damit paid wieder 0 ist.
                        if (s === 'CANCELLED' && invoice.paidAmount > 0.005) {
                          alert(`Status CANCELLED nicht möglich: ${invoice.paidAmount.toFixed(3)} BHD wurden bereits gezahlt. Zuerst Return + Refund durchführen.`);
                          return;
                        }
                        // DRAFT auf bezahlter Invoice → versteckt die Payment-Sichtbarkeit.
                        if (s === 'DRAFT' && invoice.paidAmount > 0.005) {
                          alert(`Status DRAFT nicht möglich: ${invoice.paidAmount.toFixed(3)} BHD wurden bereits gezahlt. Zuerst Zahlung stornieren.`);
                          return;
                        }
                        if (window.confirm(`Status manuell auf ${s} setzen? Wird normalerweise aus paid_amount berechnet.`)) {
                          updateInvoice(id, { status: s });
                        }
                      }}
                      className="cursor-pointer rounded"
                      style={{
                        padding: '6px 14px', fontSize: 12,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{s}</button>
                  );
                })}
                <span style={{ fontSize: 11, color: '#AA956E', marginLeft: 8 }}>
                  ⚠ nur für Korrekturen. Normalerweise reconciliert das System aus den Payments.
                </span>
              </div>
            </div>
            <div className="flex gap-2" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #E5E9EE', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={openLinesEdit}>Edit Lines ({invoice.lines.length})</Button>
              <Button variant="secondary" onClick={() => setPaymentsModal(true)}>Manage Payments</Button>
            </div>
          </Card>
        )}

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>
          {/* Icon */}
          <div className="rounded-xl flex items-center justify-center"
            style={{ height: 400, background: '#F2F7FA', border: '1px solid #E5E9EE' }}>
            <FileText size={64} strokeWidth={0.8} style={{ color: '#6B7280' }} />
          </div>

          {/* Key Info */}
          <div>
            <span className="text-overline">INVOICE</span>
            <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>{invoice.invoiceNumber}</h1>
            {customer && (
              <span style={{ fontSize: 15, color: '#4B5563', display: 'block', marginTop: 8 }}>
                {customer.firstName} {customer.lastName}{customer.company ? ` \u2014 ${customer.company}` : ''}
              </span>
            )}
            <div className="flex items-center gap-4" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <StatusDot status={invoice.status} label={derivedInvoiceLabel(invoice)} />
              {/* Return-Status Badge — Final/Partial Return/Returned */}
              {(() => {
                const sum = getInvoiceReturnSummary(invoice.id, invoice.grossAmount, invoice.paidAmount);
                if (sum.returnState === 'RETURNED') {
                  return (
                    <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: '#DC2626', background: 'rgba(220,38,38,0.08)',
                      border: '1px solid rgba(220,38,38,0.3)' }}>RETURNED</span>
                  );
                }
                if (sum.returnState === 'PARTIAL_RETURN') {
                  return (
                    <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: '#D97706', background: 'rgba(217,119,6,0.08)',
                      border: '1px solid rgba(217,119,6,0.3)' }}>PARTIAL RETURN</span>
                  );
                }
                return null;
              })()}
              {invoice.butterfly && (
                <span title="Butterfly — excluded from NBR export"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '3px 10px', borderRadius: 999,
                    fontSize: 11, fontWeight: 500,
                    color: '#AA956E',
                    background: 'rgba(170,149,110,0.10)',
                    border: '1px solid rgba(170,149,110,0.35)',
                  }}>
                  <Butterfly size={12} /> Butterfly
                </span>
              )}
              <span className="font-mono" style={{ fontSize: 13, color: '#6B7280' }}>{invoice.currency}</span>
            </div>

            {/* Financial Summary */}
            <div style={{ marginTop: 28, borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">NET AMOUNT</span>
                <span className="font-display" style={{ fontSize: 20, color: '#4B5563' }}>{fmt(invoice.netAmount)} BHD</span>
              </div>
              {invoice.taxSchemeSnapshot === 'mixed' ? (
                <>
                  {(() => {
                    const marginLines = invoice.lines.filter(l => l.taxScheme === 'MARGIN');
                    const standardLines = invoice.lines.filter(l => l.taxScheme === 'VAT_10');
                    const exemptLines = invoice.lines.filter(l => l.taxScheme === 'ZERO');
                    return <>
                      {marginLines.length > 0 && (
                        <div className="flex justify-between items-baseline" style={{ marginBottom: 6 }}>
                          <span className="text-overline" style={{ fontSize: 10 }}>VAT MARGIN SCHEME ({marginLines.length} items)</span>
                          <span className="font-mono" style={{ fontSize: 14, color: '#AA956E' }}>{fmt(marginLines.reduce((s, l) => s + l.vatAmount, 0))} BHD</span>
                        </div>
                      )}
                      {standardLines.length > 0 && (
                        <div className="flex justify-between items-baseline" style={{ marginBottom: 6 }}>
                          <span className="text-overline" style={{ fontSize: 10 }}>VAT STANDARD 10% ({standardLines.length} items)</span>
                          <span className="font-mono" style={{ fontSize: 14, color: '#AA956E' }}>{fmt(standardLines.reduce((s, l) => s + l.vatAmount, 0))} BHD</span>
                        </div>
                      )}
                      {exemptLines.length > 0 && (
                        <div className="flex justify-between items-baseline" style={{ marginBottom: 6 }}>
                          <span className="text-overline" style={{ fontSize: 10 }}>EXEMPT ({exemptLines.length} items)</span>
                          <span className="font-mono" style={{ fontSize: 14, color: '#6B7280' }}>0.00 BHD</span>
                        </div>
                      )}
                    </>;
                  })()}
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">TOTAL VAT</span>
                    <span className="font-mono" style={{ fontSize: 16, color: '#AA956E' }}>{fmt(invoice.vatAmount)} BHD</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                  <span className="text-overline">
                    {invoice.taxSchemeSnapshot === 'MARGIN' ? 'VAT (MARGIN SCHEME)' : invoice.taxSchemeSnapshot === 'VAT_10' ? `VAT (${invoice.vatRateSnapshot}%)` : 'VAT (ZERO)'}
                  </span>
                  <span className="font-mono" style={{ fontSize: 16, color: '#AA956E' }}>{fmt(invoice.vatAmount)} BHD</span>
                </div>
              )}
              <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                <span className="text-overline">GROSS TOTAL</span>
                <span className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}>{fmt(invoice.grossAmount)} BHD</span>
              </div>
              <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 10, marginTop: 4 }}>
                {creditedTotal > 0 && (
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 6 }}>
                    <span className="text-overline" style={{ color: '#FF8730' }}>CREDITED (CN)</span>
                    <span className="font-mono" style={{ fontSize: 14, color: '#FF8730' }}>−{fmt(creditedTotal)} BHD</span>
                  </div>
                )}
                <div className="flex justify-between items-baseline" style={{ marginBottom: 6 }}>
                  <span className="text-overline">PAID</span>
                  <span className="font-mono" style={{ fontSize: 16, color: '#7EAA6E' }}>{fmt(invoice.paidAmount)} BHD</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-overline">REMAINING</span>
                  <span className="font-mono" style={{ fontSize: 16, color: remaining > 0 ? '#AA6E6E' : '#7EAA6E' }}>{fmt(Math.max(0, remaining))} BHD</span>
                </div>
                {(invoice.tipAmount || 0) > 0 && (
                  <div className="flex justify-between items-baseline" style={{ marginTop: 6 }}>
                    <span className="text-overline" style={{ color: '#0F0F10' }}>TIP</span>
                    <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(invoice.tipAmount || 0)} BHD</span>
                  </div>
                )}
              </div>
            </div>

            {/* Tax Scheme */}
            <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div className="flex justify-between items-center" style={{ marginBottom: invoice.taxSchemeSnapshot === 'mixed' ? 8 : 0 }}>
                <span style={{ fontSize: 12, color: '#6B7280' }}>Tax Scheme</span>
                <span style={{ fontSize: 12, color: invoice.taxSchemeSnapshot === 'mixed' ? '#AA956E' : '#0F0F10' }}>
                  {invoice.taxSchemeSnapshot === 'MARGIN' ? 'Margin Scheme' : invoice.taxSchemeSnapshot === 'VAT_10' ? 'VAT 10%' : invoice.taxSchemeSnapshot === 'mixed' ? 'Mixed (per item)' : 'Zero'}
                </span>
              </div>
              {invoice.taxSchemeSnapshot === 'mixed' && (() => {
                const marginLines = invoice.lines.filter(l => l.taxScheme === 'MARGIN');
                const standardLines = invoice.lines.filter(l => l.taxScheme === 'VAT_10');
                const marginVat = marginLines.reduce((s, l) => s + l.vatAmount, 0);
                const standardVat = standardLines.reduce((s, l) => s + l.vatAmount, 0);
                return (
                  <>
                    {marginLines.length > 0 && (
                      <div className="flex justify-between" style={{ fontSize: 11, marginTop: 4 }}>
                        <span style={{ color: '#6B7280' }}>Margin Scheme ({marginLines.length} items)</span>
                        <span className="font-mono" style={{ color: '#AA956E' }}>{fmt(marginVat)} BHD VAT</span>
                      </div>
                    )}
                    {standardLines.length > 0 && (
                      <div className="flex justify-between" style={{ fontSize: 11, marginTop: 4 }}>
                        <span style={{ color: '#6B7280' }}>Standard VAT ({standardLines.length} items)</span>
                        <span className="font-mono" style={{ color: '#AA956E' }}>{fmt(standardVat)} BHD VAT</span>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Content Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

          {/* Invoice Lines */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>INVOICE LINES</span>
            <div style={{ marginTop: 16 }}>
              {invoice.lines.length === 0 && (
                <p style={{ fontSize: 13, color: '#6B7280' }}>No line items</p>
              )}
              {invoice.lines.map((line, idx) => {
                const returnedQty = getReturnedQtyForLine(line.id);
                const lineQty = Math.max(1, line.quantity || 1);
                const fullyReturned = returnedQty >= lineQty;
                const partiallyReturned = returnedQty > 0 && returnedQty < lineQty;
                return (
                <div key={line.id} style={{
                  padding: '12px 0',
                  borderBottom: idx < invoice.lines.length - 1 ? '1px solid #E5E9EE' : 'none',
                  background: fullyReturned ? 'rgba(220,38,38,0.04)' : partiallyReturned ? 'rgba(217,119,6,0.04)' : 'transparent',
                  marginLeft: -8, marginRight: -8, paddingLeft: 8, paddingRight: 8, borderRadius: 6,
                }}>
                  <div className="flex justify-between items-start" style={{ marginBottom: 6 }}>
                    <div>
                      <span style={{ fontSize: 13, color: '#0F0F10', fontWeight: 500, textDecoration: fullyReturned ? 'line-through' : 'none', textDecorationColor: '#DC2626' }}>
                        {(line.quantity || 1) > 1 && (
                          <span className="font-mono" style={{
                            marginRight: 8, padding: '1px 6px', borderRadius: 3,
                            fontSize: 11, color: '#AA956E',
                            background: 'rgba(170,149,110,0.1)',
                            border: '1px solid rgba(170,149,110,0.3)',
                          }}>{line.quantity}×</span>
                        )}
                        {getProductName(line.productId)}
                      </span>
                      {/* Return-Markierung am Line-Item */}
                      {returnedQty > 0 && (
                        <span style={{
                          marginLeft: 8, padding: '2px 8px', borderRadius: 999,
                          fontSize: 10, fontWeight: 500,
                          color: fullyReturned ? '#DC2626' : '#D97706',
                          background: fullyReturned ? 'rgba(220,38,38,0.1)' : 'rgba(217,119,6,0.1)',
                          border: `1px solid ${fullyReturned ? 'rgba(220,38,38,0.3)' : 'rgba(217,119,6,0.3)'}`,
                        }}>
                          {fullyReturned ? `RETURNED (${returnedQty}/${lineQty})` : `${returnedQty}/${lineQty} RETURNED`}
                        </span>
                      )}
                      {line.description && <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginTop: 2 }}>{line.description}</span>}
                    </div>
                    <span className="font-mono" style={{ fontSize: 13, color: fullyReturned ? '#6B7280' : '#0F0F10', whiteSpace: 'nowrap', textDecoration: fullyReturned ? 'line-through' : 'none' }}>{fmt(line.lineTotal)} BHD</span>
                  </div>
                  <div className="flex items-center gap-4" style={{ fontSize: 11, color: '#6B7280' }}>
                    <span style={{
                      fontSize: 9, padding: '1px 6px', borderRadius: 3, fontWeight: 500, letterSpacing: '0.04em',
                      background: line.taxScheme === 'MARGIN' ? 'rgba(170,149,110,0.1)' : line.taxScheme === 'VAT_10' ? 'rgba(110,138,170,0.1)' : 'rgba(107,107,115,0.1)',
                      color: line.taxScheme === 'MARGIN' ? '#AA956E' : line.taxScheme === 'VAT_10' ? '#6E8AAA' : '#6B7280',
                      border: `1px solid ${line.taxScheme === 'MARGIN' ? 'rgba(170,149,110,0.2)' : line.taxScheme === 'VAT_10' ? 'rgba(110,138,170,0.2)' : 'rgba(107,107,115,0.2)'}`,
                      textTransform: 'uppercase',
                    }}>{line.taxScheme === 'MARGIN' ? 'Margin' : line.taxScheme === 'VAT_10' ? 'Std 10%' : 'Exempt'}</span>
                    <span>Unit: <span className="font-mono" style={{ color: '#4B5563' }}>{fmt(line.unitPrice)}</span></span>
                    {line.taxScheme === 'MARGIN' && (
                      <span>Margin: <span className="font-mono" style={{ color: '#4B5563' }}>{fmt(line.unitPrice - line.purchasePriceSnapshot)}</span></span>
                    )}
                    <span>VAT: <span className="font-mono" style={{ color: '#AA956E' }}>{fmt(line.vatAmount)}</span></span>
                  </div>
                </div>
                );
              })}
            </div>
          </Card>

          {/* Details & Margin */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Details */}
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>DETAILS</span>
              <div style={{ marginTop: 16 }}>
                {renderField('Invoice Number', invoice.invoiceNumber)}
                {renderField('Status', <StatusDot status={invoice.status} label={derivedInvoiceLabel(invoice)} />)}
                {renderField('Issued', fmtDate(invoice.issuedAt))}
                {editing ? (
                  <div style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
                    <Input required label="DUE DATE" type="date" value={editDueAt} onChange={e => setEditDueAt(e.target.value)} />
                  </div>
                ) : (
                  renderField('Due', fmtDate(invoice.dueAt))
                )}
                {renderField('Created', fmtDate(invoice.createdAt))}
                {invoice.offerId && renderField('Linked Offer', invoice.offerId.slice(0, 8) + '...')}

                {editing ? (
                  <div style={{ marginTop: 12 }}>
                    <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                    <textarea
                      value={editNotes}
                      onChange={e => setEditNotes(e.target.value)}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                ) : invoice.notes ? (
                  <div style={{ marginTop: 16 }}>
                    <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                    <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{invoice.notes}</p>
                  </div>
                ) : null}
              </div>
            </Card>

            {/* Margin Info */}
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>MARGIN ANALYSIS</span>
              <div style={{ marginTop: 16 }}>
                <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
                  <span style={{ fontSize: 13, color: '#6B7280' }}>Purchase Snapshot</span>
                  <span className="font-mono" style={{ fontSize: 13, color: '#4B5563' }}>
                    {invoice.purchasePriceSnapshot != null ? `${fmt(invoice.purchasePriceSnapshot)} BHD` : '\u2014'}
                  </span>
                </div>
                <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
                  <span style={{ fontSize: 13, color: '#6B7280' }}>Sale Snapshot</span>
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>
                    {invoice.salePriceSnapshot != null ? `${fmt(invoice.salePriceSnapshot)} BHD` : '\u2014'}
                  </span>
                </div>
                <div className="flex justify-between items-center" style={{ padding: '10px 0' }}>
                  <span style={{ fontSize: 13, color: '#6B7280' }}>Margin</span>
                  <span className="font-mono" style={{ fontSize: 15, color: (invoice.marginSnapshot || 0) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                    {invoice.marginSnapshot != null ? `${fmt(invoice.marginSnapshot)} BHD` : '\u2014'}
                  </span>
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* Returns + Refund Section — sichtbar wenn Returns existieren */}
        {(() => {
          const sum = getInvoiceReturnSummary(invoice.id, invoice.grossAmount, invoice.paidAmount);
          if (sum.returns.length === 0) return null;
          return (
            <div style={{ marginTop: 24 }}>
              <Card>
                <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                  <span className="text-overline">RETURNS &amp; REFUNDS</span>
                  <div className="flex items-center gap-3">
                    <span style={{ fontSize: 11, color: '#6B7280' }}>
                      Return Status: <strong style={{ color: sum.returnState === 'RETURNED' ? '#DC2626' : '#D97706' }}>
                        {sum.returnState.replace(/_/g, ' ')}
                      </strong>
                    </span>
                    <span style={{ fontSize: 11, color: '#6B7280' }}>
                      Refund: <strong style={{
                        color: sum.refundState === 'REFUNDED' ? '#7EAA6E'
                          : sum.refundState === 'PARTIALLY_REFUNDED' ? '#D97706' : '#DC2626'
                      }}>
                        {sum.refundState.replace(/_/g, ' ')}
                      </strong>
                    </span>
                  </div>
                </div>
                {/* Summary numbers */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16, padding: '12px 14px', background: '#F7F5EE', borderRadius: 8 }}>
                  <div>
                    <span style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Return Amount</span>
                    <div className="font-mono" style={{ fontSize: 16, color: '#0F0F10', marginTop: 2 }}>{fmt(sum.totalReturned)} BHD</div>
                  </div>
                  <div>
                    <span style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Refund Paid</span>
                    <div className="font-mono" style={{ fontSize: 16, color: '#7EAA6E', marginTop: 2 }}>{fmt(sum.totalRefundPaid)} BHD</div>
                  </div>
                  <div>
                    <span style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Outstanding Refund</span>
                    <div className="font-mono" style={{ fontSize: 16, color: sum.outstandingRefund > 0 ? '#DC2626' : '#6B7280', marginTop: 2 }}>{fmt(sum.outstandingRefund)} BHD</div>
                  </div>
                </div>
                {/* Per-Return Details */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sum.returns.map(r => {
                    // Cash-Outstanding pro Return: max das was Customer überzahlt hat,
                    // proportional auf diesen Return runtergebrochen, minus bereits gezahlt.
                    // Vereinfachung: wenn invoice-weite outstanding=0 ist, ist auch pro Return 0.
                    const ownedTotal = Math.max(0, r.totalAmount - (r.refundPaidAmount || 0));
                    const outstanding = sum.outstandingRefund <= 0.01 ? 0 : ownedTotal;
                    const lineProductNames = r.lines.map(l => {
                      const p = products.find(pp => pp.id === l.productId);
                      return p ? `${l.quantity}× ${p.brand} ${p.name}` : `${l.quantity}× —`;
                    }).join(', ');
                    const linkedCN = creditNotes.find(cn => cn.salesReturnId === r.id);
                    return (
                      <div key={r.id} style={{ padding: '12px 14px', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                        <div className="flex justify-between items-start" style={{ marginBottom: 8 }}>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', fontWeight: 500 }}>{r.returnNumber}</span>
                              {linkedCN && (
                                <Link to={`/credit-notes/${linkedCN.id}`} className="cursor-pointer flex items-center gap-1"
                                  style={{ fontSize: 11, color: '#FF8730', textDecoration: 'none', padding: '2px 8px', borderRadius: 999, border: '1px solid rgba(255,135,48,0.3)', background: 'rgba(255,135,48,0.06)' }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,135,48,0.12)')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,135,48,0.06)')}>
                                  {linkedCN.creditNoteNumber}
                                  <ExternalLink size={9} style={{ opacity: 0.7 }} />
                                </Link>
                              )}
                              {(() => {
                                // Wenn nichts auszuzahlen ist (Customer hat nicht gezahlt), aber Return existiert → SETTLED.
                                const effectiveStatus = outstanding <= 0.01 && r.refundStatus !== 'PARTIALLY_REFUNDED' ? 'SETTLED' : r.refundStatus;
                                const colorMap: Record<string, { fg: string; bg: string }> = {
                                  REFUNDED: { fg: '#7EAA6E', bg: 'rgba(126,170,110,0.1)' },
                                  SETTLED:  { fg: '#7EAA6E', bg: 'rgba(126,170,110,0.1)' },
                                  PARTIALLY_REFUNDED: { fg: '#D97706', bg: 'rgba(217,119,6,0.1)' },
                                  NOT_REFUNDED: { fg: '#DC2626', bg: 'rgba(220,38,38,0.1)' },
                                };
                                const { fg, bg } = colorMap[effectiveStatus] || colorMap.NOT_REFUNDED;
                                return (
                                  <span title={effectiveStatus === 'SETTLED' ? 'No cash refund needed — customer never paid' : undefined}
                                    style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, color: fg, background: bg, border: `1px solid ${fg}30` }}>
                                    {effectiveStatus.replace(/_/g, ' ')}
                                  </span>
                                );
                              })()}
                            </div>
                            <span style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>
                              Return Date: {r.returnDate} {r.refundPaidDate ? ` · Refund Date: ${r.refundPaidDate}` : ''}
                            </span>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span className="font-mono" style={{ fontSize: 14, color: '#DC2626' }}>−{fmt(r.totalAmount)} BHD</span>
                            {r.refundPaidAmount > 0 && (
                              <span style={{ fontSize: 11, color: '#7EAA6E', display: 'block', marginTop: 2 }}>
                                Paid: {fmt(r.refundPaidAmount)} {r.refundMethod ? `(${r.refundMethod})` : ''}
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Returned items */}
                        <div style={{ fontSize: 11, color: '#4B5563', marginBottom: 6 }}>
                          <span style={{ color: '#6B7280' }}>Items: </span>{lineProductNames}
                        </div>
                        {r.reason && (
                          <div style={{ fontSize: 11, color: '#4B5563', marginBottom: 6 }}>
                            <span style={{ color: '#6B7280' }}>Reason: </span>{r.reason}
                          </div>
                        )}
                        {/* Action — Record Refund Payment (Plan §Returns Fix: Modal statt window.prompt) */}
                        {outstanding > 0 && perm.canRecordPayments && r.refundStatus !== 'REFUNDED' && (
                          <div className="flex gap-2 items-center" style={{ marginTop: 8 }}>
                            <span style={{ fontSize: 11, color: '#DC2626' }}>Outstanding: <span className="font-mono">{fmt(outstanding)} BHD</span></span>
                            <button onClick={() => {
                              // Industry-Standard: Cash-Refund max = was Customer tatsächlich gezahlt hat.
                              const customerPaid = invoice.paidAmount || 0;
                              const cappedDefault = Math.min(outstanding, customerPaid);
                              setRefundPayModal({ returnId: r.id, outstanding: cappedDefault });
                              setRefundPayAmount(cappedDefault.toFixed(3));
                              setRefundPayMethod((r.refundMethod as 'cash' | 'bank' | 'card' | 'credit' | 'other') || 'bank');
                            }}
                              className="cursor-pointer" style={{ padding: '4px 10px', fontSize: 11, border: '1px solid #7EAA6E', color: '#7EAA6E', borderRadius: 4, background: 'none' }}>
                              Record Refund Payment
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          );
        })()}
      </div>

      {/* Edit Lines Modal */}
      <Modal open={linesModal} onClose={() => setLinesModal(false)} title={`Edit Lines — ${invoice.invoiceNumber}`} width={1000}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: '#6B7280' }}>
            Klick auf den Produktnamen → anderes Produkt auswählen. Quantity nur sichtbar bei Produkten mit Lager &gt; 1. Tax + Total werden live nach Schema neu berechnet. Alle Änderungen werden geloggt.
          </p>
          <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'visible', position: 'relative' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.8fr) minmax(0,1.2fr) 50px minmax(0,0.9fr) minmax(0,0.9fr) 55px minmax(0,0.9fr) minmax(0,0.9fr) 44px', gap: 8, padding: '8px 10px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE', fontSize: 10, color: '#6B7280', textTransform: 'uppercase' }}>
              <span>Product</span>
              <span>Description</span>
              <span>Qty</span>
              <span>Unit Net</span>
              <span>Purchase</span>
              <span>VAT %</span>
              <span>Scheme</span>
              <span style={{ textAlign: 'right' }}>Line Total</span>
              <span></span>
            </div>
            {lineDraft.map((l, idx) => {
              const product = products.find(p => p.id === l.productId);
              const stock = product?.quantity || 1;
              const showQty = stock > 1; // Per User-Regel: Qty nur wenn Lager > 1
              return (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.8fr) minmax(0,1.2fr) 50px minmax(0,0.9fr) minmax(0,0.9fr) 55px minmax(0,0.9fr) minmax(0,0.9fr) 44px', gap: 8, padding: '8px 10px', borderBottom: '1px solid #E5E9EE', alignItems: 'center', position: 'relative' }}>
                  {/* Product picker — Klick öffnet Suche */}
                  <button onClick={() => { setProductPickerIdx(productPickerIdx === idx ? null : idx); setProductPickerQuery(''); }}
                    className="cursor-pointer text-left" style={{
                      padding: '6px 8px', fontSize: 12, background: '#FFFFFF', border: '1px solid #D5D9DE', borderRadius: 4,
                      color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      minWidth: 0, width: '100%',
                    }} title="Klick zum Wechseln">
                    {product ? `${product.brand} ${product.name}` : '— pick product —'}
                  </button>
                  {productPickerIdx === idx && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 8, zIndex: 100,
                      width: 360, maxHeight: 320, overflowY: 'auto',
                      background: '#FFFFFF', border: '1px solid #0F0F10', borderRadius: 6,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.15)', padding: 6,
                    }}>
                      <input autoFocus value={productPickerQuery}
                        onChange={e => setProductPickerQuery(e.target.value)}
                        placeholder="Search by brand, name, SKU…"
                        style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, marginBottom: 6 }} />
                      {products
                        .filter(p => {
                          if (!productPickerQuery) return true;
                          const q = productPickerQuery.toLowerCase();
                          return (`${p.brand} ${p.name} ${p.sku || ''}`).toLowerCase().includes(q);
                        })
                        .slice(0, 30)
                        .map(p => (
                          <button key={p.id} onClick={() => pickProductForLine(idx, p.id)}
                            className="cursor-pointer flex justify-between" style={{
                              width: '100%', padding: '6px 8px', fontSize: 12, background: 'transparent', border: 'none',
                              borderBottom: '1px solid #E5E9EE', textAlign: 'left', color: '#0F0F10',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.04)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            <span>{p.brand} {p.name} {p.sku ? <span style={{ color: '#6B7280' }}>· {p.sku}</span> : ''}</span>
                            <span className="font-mono" style={{ color: '#6B7280' }}>{(p.plannedSalePrice ?? p.purchasePrice).toFixed(0)}</span>
                          </button>
                        ))}
                    </div>
                  )}
                  <input value={l.description}
                    onChange={e => recalcLine(idx, { description: e.target.value })}
                    placeholder="Description" style={{ padding: '4px 6px', fontSize: 11, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, minWidth: 0, width: '100%' }} />
                  {showQty ? (
                    <input type="number" min={1} max={stock} value={l.quantity}
                      onChange={e => recalcLine(idx, { quantity: Math.max(1, Math.min(stock, parseInt(e.target.value) || 1)) })}
                      title={`Stock: ${stock}`}
                      className="font-mono" style={{ padding: '4px 6px', fontSize: 11, background: '#FFF8E5', border: '1px solid #C6A36D', borderRadius: 4, minWidth: 0, width: '100%' }} />
                  ) : (
                    <span style={{ fontSize: 11, color: '#6B7280', textAlign: 'center', minWidth: 0 }}>1</span>
                  )}
                  <input type="number" step="0.001" value={l.unitPrice}
                    onChange={e => recalcLine(idx, { unitPrice: parseFloat(e.target.value) || 0 })}
                    className="font-mono" style={{ padding: '4px 6px', fontSize: 11, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, minWidth: 0, width: '100%' }} />
                  <input type="number" step="0.001" value={l.purchasePrice}
                    onChange={e => recalcLine(idx, { purchasePrice: parseFloat(e.target.value) || 0 })}
                    className="font-mono" style={{ padding: '4px 6px', fontSize: 11, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, minWidth: 0, width: '100%' }} />
                  <input type="number" value={l.vatRate}
                    onChange={e => recalcLine(idx, { vatRate: parseFloat(e.target.value) || 0 })}
                    className="font-mono" style={{ padding: '4px 6px', fontSize: 11, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, minWidth: 0, width: '100%' }} />
                  <select value={l.taxScheme}
                    onChange={e => recalcLine(idx, { taxScheme: e.target.value })}
                    style={{ padding: '4px 6px', fontSize: 11, border: '1px solid #D5D9DE', borderRadius: 4, minWidth: 0, width: '100%' }}>
                    <option value="MARGIN">Margin</option>
                    <option value="VAT_10">VAT 10%</option>
                    <option value="ZERO">Zero</option>
                  </select>
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(l.lineTotal)}</span>
                  <button onClick={() => setLineDraft(d => d.filter((_, i) => i !== idx))}
                    title="Diese Zeile entfernen"
                    className="cursor-pointer transition-all"
                    style={{
                      width: 32, height: 32, borderRadius: 8,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'rgba(220,38,38,0.10)',
                      border: '1px solid rgba(220,38,38,0.30)',
                      color: '#DC2626',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#DC2626'; e.currentTarget.style.color = '#FFFFFF'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(220,38,38,0.10)'; e.currentTarget.style.color = '#DC2626'; }}>
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex items-center" style={{ marginTop: 4 }}>
            <Button variant="secondary" onClick={addLine}><Plus size={12} /> Add Line</Button>
          </div>
          <div className="flex justify-between items-center" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <span style={{ fontSize: 12, color: '#6B7280' }}>
              Net: <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(lineDraft.reduce((s, l) => s + (Number(l.unitPrice) || 0) * Math.max(1, Number(l.quantity) || 1), 0))}</span>
              {' · '}VAT: <span className="font-mono" style={{ color: '#AA956E' }}>{fmt(lineDraft.reduce((s, l) => s + (Number(l.vatAmount) || 0) * Math.max(1, Number(l.quantity) || 1), 0))}</span>
              {' · '}Gross: <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(lineDraft.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0))}</span> BHD
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setLinesModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={saveLines} disabled={lineDraft.length === 0}>Save Lines</Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Manage Payments Modal */}
      <Modal open={paymentsModal} onClose={() => setPaymentsModal(false)} title={`Payments — ${invoice.invoiceNumber}`} width={680}>
        {(() => {
          const list = id ? getInvoicePayments(id) : [];
          if (list.length === 0) {
            return <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No payments recorded yet.</p>;
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ fontSize: 12, color: '#6B7280' }}>
                Methode oder Betrag editieren: in Felder klicken und mit Enter bestätigen. Löschen rechts.
              </p>
              <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.5fr 0.5fr', gap: 8, padding: '8px 12px', background: '#F2F7FA', fontSize: 10, color: '#6B7280', textTransform: 'uppercase' }}>
                  <span>Date</span><span>Amount (BHD)</span><span>Method</span><span>Notes</span><span></span>
                </div>
                {list.map(p => (
                  <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.5fr 0.5fr', gap: 8, padding: '8px 12px', borderTop: '1px solid #E5E9EE', alignItems: 'center' }}>
                    <input type="date" defaultValue={(p.receivedAt || '').split('T')[0]}
                      onBlur={e => { if (e.target.value && id) updatePayment(p.id, id, { receivedAt: new Date(e.target.value).toISOString() }); }}
                      style={{ padding: '4px 6px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4 }} />
                    <input type="number" step="0.001" defaultValue={p.amount}
                      onBlur={e => { if (id) updatePayment(p.id, id, { amount: parseFloat(e.target.value) || 0 }); }}
                      className="font-mono" style={{ padding: '4px 6px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4 }} />
                    <select defaultValue={p.method}
                      onChange={e => { if (id) updatePayment(p.id, id, { method: e.target.value }); }}
                      style={{ padding: '4px 6px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4 }}>
                      <option value="cash">Cash</option>
                      <option value="bank">Bank</option>
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="card">Card</option>
                      <option value="crypto">Crypto</option>
                      <option value="other">Other</option>
                    </select>
                    <input defaultValue={p.notes || ''}
                      onBlur={e => { if (id) updatePayment(p.id, id, { notes: e.target.value }); }}
                      placeholder="Notes" style={{ padding: '4px 6px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4 }} />
                    <button onClick={() => { if (window.confirm('Delete this payment? Status wird neu berechnet.')) { if (id) deletePayment(p.id, id); } }}
                      className="cursor-pointer" style={{ padding: '4px 8px', fontSize: 12, background: 'none', border: '1px solid #D5D9DE', borderRadius: 4, color: '#AA6E6E' }}>×</button>
                  </div>
                ))}
              </div>
              <div className="flex justify-end" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                <Button variant="primary" onClick={() => setPaymentsModal(false)}>Close</Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Record Payment Modal */}
      <Modal open={paymentOpen} onClose={() => setPaymentOpen(false)} title="Record Payment" width={440}>
        <div style={{ marginBottom: 20 }}>
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 16 }}>
            Outstanding: <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(remaining)} BHD</span>
          </p>
          <Input
            label="AMOUNT (BHD)"
            type="number"
            value={paymentAmount}
            onChange={e => setPaymentAmount(e.target.value)}
            step="0.01"
            min="0.01"
            max={String(remaining)}
          />
          <div style={{ marginTop: 16 }}>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>PAYMENT METHOD</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {PAYMENT_METHODS.map(m => (
                <button
                  key={m.value}
                  onClick={() => setPaymentMethod(m.value)}
                  className="cursor-pointer"
                  style={{
                    padding: '6px 14px', fontSize: 12, borderRadius: 6,
                    border: paymentMethod === m.value ? '1px solid #0F0F10' : '1px solid #D5D9DE',
                    background: paymentMethod === m.value ? 'rgba(15,15,16,0.08)' : 'transparent',
                    color: paymentMethod === m.value ? '#0F0F10' : '#6B7280',
                  }}
                >{m.label}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setPaymentOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleRecordPayment}>Confirm Payment</Button>
        </div>
      </Modal>

      {/* Cancel Confirmation Modal — Plan §Sales §14 */}
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel Invoice" width={460}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 12 }}>
          Cancel invoice <strong style={{ color: '#0F0F10' }}>{invoice.invoiceNumber}</strong>?
        </p>
        <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12, color: '#4B5563', marginBottom: 16 }}>
          <div style={{ marginBottom: 6 }}>• Products will be released back to IN_STOCK ({invoice.lines.length} item{invoice.lines.length > 1 ? 's' : ''}).</div>
          {invoice.paidAmount > 0 ? (
            <div>• Refund of <strong style={{ color: '#0F0F10' }}>{invoice.paidAmount.toFixed(3)} BHD</strong> will be recorded as Sales Return.</div>
          ) : (
            <div>• No payment received, so no refund will be issued.</div>
          )}
        </div>
        {invoice.paidAmount > 0 && (
          <div style={{ marginBottom: 20 }}>
            <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>REFUND METHOD</span>
            <div className="flex gap-2">
              {(['cash', 'bank'] as const).map(m => (
                <button key={m} onClick={() => setCancelRefundMethod(m)}
                  className="cursor-pointer rounded" style={{
                    padding: '6px 14px', fontSize: 12,
                    border: `1px solid ${cancelRefundMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: cancelRefundMethod === m ? '#0F0F10' : '#6B7280',
                    background: cancelRefundMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep Invoice</Button>
          <Button variant="danger" onClick={handleCancelInvoice}>Cancel Invoice</Button>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Invoice" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Permanently delete <strong style={{ color: '#0F0F10' }}>{invoice.invoiceNumber}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDeleteInvoice}>Delete</Button>
        </div>
      </Modal>

      {/* Print Receipt — CUSTOMER-FACING (konform) */}
      <div className="print-receipt" style={{ display: 'none' }}>
        <style>{`@media print { .print-receipt { display: block !important; } .no-print, .app-content > div:first-child { display: none !important; } }`}</style>
        <div className="receipt-header">
          <img src={logoUrl} alt="Lataif Jewellery" style={{ width: '25%', maxWidth: 200, height: 'auto', display: 'block', margin: '0 auto 8px' }} />
          <p>Luxury Trading</p>
          <p>Manama, Bahrain</p>
        </div>
        <div className="receipt-meta">
          <div><span>Invoice:</span><span>{invoice.invoiceNumber}</span></div>
          <div><span>Date:</span><span>{fmtDate(invoice.issuedAt || invoice.createdAt)}</span></div>
          {customer && <div><span>Client:</span><span>{customer.firstName} {customer.lastName}</span></div>}
        </div>
        <div className="receipt-lines">
          {invoice.lines.map(line => {
            // Plan §Print — Specs als 2-Spalten-Mini-Grid (kompakt + ästhetisch).
            const product = products.find(p => p.id === line.productId);
            const specs = getProductSpecs(product, categories);
            const SpecsGrid = specs.length > 0 ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                columnGap: 16, rowGap: 1,
                marginTop: 4, fontSize: '9px',
                color: '#444',
              }}>
                {specs.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 4, lineHeight: 1.35, breakInside: 'avoid' }}>
                    <span style={{ color: '#999', minWidth: 0 }}>{s.label}:</span>
                    <span style={{ color: '#222', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.value}</span>
                  </div>
                ))}
              </div>
            ) : null;

            if (line.taxScheme === 'MARGIN') {
              return (
                <div key={line.id} className="receipt-line" style={{ flexDirection: 'column' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="receipt-line-name">{getProductName(line.productId)}</span>
                    <span>{fmt(line.lineTotal)} BHD</span>
                  </div>
                  {SpecsGrid}
                </div>
              );
            }
            return (
              <div key={line.id} className="receipt-line" style={{ flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="receipt-line-name">{getProductName(line.productId)}</span>
                  <span>{fmt(line.lineTotal)} BHD</span>
                </div>
                {SpecsGrid}
                <div style={{ fontSize: '9px', color: '#888', display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span>Net: {fmt(line.unitPrice)}</span>
                  <span>VAT 10%: {fmt(line.vatAmount)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="receipt-totals">
          {(() => {
            const stdLines = invoice.lines.filter(l => l.taxScheme === 'VAT_10');
            const stdVat = stdLines.reduce((s, l) => s + l.vatAmount, 0);
            const hasStandard = stdLines.length > 0;
            return <>
              {hasStandard && <div><span>VAT (10%):</span><span>{fmt(stdVat)} BHD</span></div>}
            </>;
          })()}
          <div className="receipt-grand-total"><span>TOTAL:</span><span>{fmt(invoice.grossAmount)} BHD</span></div>
          {invoice.paidAmount > 0 && <div><span>Paid:</span><span>{fmt(invoice.paidAmount)} BHD</span></div>}
          {remaining > 0 && <div><span>Due:</span><span>{fmt(remaining)} BHD</span></div>}
        </div>
        <div className="receipt-footer">
          <p>Thank you for your business</p>
        </div>
      </div>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="invoices"
        entityId={invoice.id}
        title={`History · ${invoice.invoiceNumber}`}
      />

      {/* Plan §Returns Fix — Refund Payment Modal (statt browserprompt) */}
      <Modal open={!!refundPayModal} onClose={() => setRefundPayModal(null)} title="Record Refund Payment" width={420}>
        {refundPayModal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <span className="text-overline" style={{ marginBottom: 4, display: 'block' }}>OUTSTANDING</span>
              <div className="font-mono" style={{ fontSize: 18, color: '#DC2626' }}>
                {fmt(refundPayModal.outstanding)} BHD
              </div>
            </div>
            <Input required label="AMOUNT (BHD)" type="number" step="0.001"
              value={refundPayAmount}
              onChange={e => setRefundPayAmount(e.target.value)} />
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
              <div className="flex gap-2 flex-wrap" style={{ marginTop: 6 }}>
                {(['cash', 'bank', 'card', 'credit', 'other'] as const).map(m => {
                  const active = refundPayMethod === m;
                  const label = m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : m === 'card' ? 'Card' : m === 'credit' ? 'Credit' : 'Other';
                  return (
                    <button key={m} type="button" onClick={() => setRefundPayMethod(m)}
                      className="cursor-pointer rounded"
                      style={{ padding: '8px 14px', fontSize: 12,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{label}</button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => setRefundPayModal(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => {
                const amt = parseFloat(refundPayAmount);
                if (!amt || amt <= 0) return;
                const capped = Math.min(amt, refundPayModal.outstanding);
                recordRefundPayment(refundPayModal.returnId, capped, refundPayMethod);
                setRefundPayModal(null);
                setRefundPayAmount('');
              }}>Record Payment</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Sales Return Modal (Plan §Returns) */}
      <Modal open={showReturn} onClose={() => setShowReturn(false)} title="Return from Customer (RET)" width={720}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 12, color: '#6B7280' }}>
            Plan §Returns: Wähle die Positionen, die der Kunde zurückgibt. Das Produkt bekommt den gewählten Status. Refund geht aus Cash/Bank.
          </p>

          {/* Linked existing returns */}
          {salesReturns.filter(r => r.invoiceId === invoice.id).length > 0 && (
            <div style={{ padding: '10px 14px', background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <span className="text-overline" style={{ marginBottom: 4, display: 'block' }}>PREVIOUS RETURNS</span>
              {salesReturns.filter(r => r.invoiceId === invoice.id).map(r => (
                <div key={r.id} className="flex justify-between" style={{ fontSize: 12, padding: '4px 0' }}>
                  <span className="font-mono" style={{ color: '#0F0F10' }}>{r.returnNumber}</span>
                  <span style={{ color: '#6B7280' }}>{r.status}</span>
                  <span className="font-mono" style={{ color: '#DC2626' }}>{fmt(r.totalAmount)} BHD</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '32px minmax(0,2fr) minmax(0,0.8fr) minmax(0,1fr) minmax(0,1fr)', gap: 10, padding: '10px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE' }}>
              {['', 'PRODUCT', 'QTY', 'UNIT PRICE (incl. VAT)', 'TOTAL (incl. VAT)'].map(h => (
                <span key={h} className="text-overline" style={{ fontSize: 10 }}>{h}</span>
              ))}
            </div>
            {invoice.lines.map(l => {
              // Gross-Unit-Preis = das was der Kunde pro Stück gezahlt hat (inkl. VAT).
              const grossUnit = l.lineTotal / Math.max(1, l.quantity);
              // Restliche Return-Quantity nach Abzug bereits zurückgegebener — keine Doppel-Returns.
              const alreadyReturned = getReturnedQtyForLine(l.id);
              const remainingQty = Math.max(0, l.quantity - alreadyReturned);
              const fullyReturned = remainingQty <= 0.005;
              const r = returnLines[l.id] || { include: false, quantity: Math.min(1, remainingQty), unitPrice: grossUnit };
              if (fullyReturned) {
                // Vollständig zurückgegebene Lines werden als "✓ already returned" angezeigt — disabled.
                return (
                  <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '32px minmax(0,2fr) minmax(0,0.8fr) minmax(0,1fr) minmax(0,1fr)', gap: 10, padding: '10px 12px', borderBottom: '1px solid #E5E9EE', alignItems: 'center', background: '#F8FAFC', opacity: 0.6 }}>
                    <input type="checkbox" checked={false} disabled style={{ cursor: 'not-allowed' }} />
                    <span style={{ fontSize: 12, color: '#6B7280', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getProductName(l.productId)}
                      <span style={{ marginLeft: 8, fontSize: 10, color: '#16A34A', fontWeight: 500 }}>✓ already returned</span>
                    </span>
                    <span className="font-mono" style={{ fontSize: 11, color: '#9CA3AF' }}>{alreadyReturned} / {l.quantity}</span>
                    <span className="font-mono" style={{ fontSize: 11, color: '#9CA3AF' }}>—</span>
                    <span className="font-mono" style={{ fontSize: 11, color: '#9CA3AF' }}>—</span>
                  </div>
                );
              }
              return (
                <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '32px minmax(0,2fr) minmax(0,0.8fr) minmax(0,1fr) minmax(0,1fr)', gap: 10, padding: '10px 12px', borderBottom: '1px solid #E5E9EE', alignItems: 'center' }}>
                  <input type="checkbox" checked={r.include} onChange={e => setReturnLines({ ...returnLines, [l.id]: { ...r, include: e.target.checked } })} />
                  <span style={{ fontSize: 12, color: '#0F0F10', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getProductName(l.productId)}
                    {alreadyReturned > 0 && (
                      <span style={{ marginLeft: 8, fontSize: 10, color: '#FF8730' }}>({alreadyReturned} of {l.quantity} returned)</span>
                    )}
                  </span>
                  <input type="number" value={r.quantity} min={0} max={remainingQty} step="0.01"
                    onChange={e => {
                      const v = Math.max(0, Math.min(remainingQty, parseFloat(e.target.value) || 0));
                      setReturnLines({ ...returnLines, [l.id]: { ...r, quantity: v } });
                    }}
                    title={`Max ${remainingQty} (already returned: ${alreadyReturned})`}
                    className="font-mono" style={{ padding: '4px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, color: '#0F0F10', minWidth: 0, width: '100%' }} />
                  <input type="number" step="0.01" value={r.unitPrice} onChange={e => setReturnLines({ ...returnLines, [l.id]: { ...r, unitPrice: parseFloat(e.target.value) || 0 } })}
                    className="font-mono" style={{ padding: '4px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, color: '#0F0F10', minWidth: 0, width: '100%' }} />
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(r.quantity * r.unitPrice)}</span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>REFUND METHOD</span>
              <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                {(['cash', 'bank', 'card', 'credit', 'other'] as const).map(m => {
                  const active = returnRefundMethod === m;
                  const label = m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank Transfer' : m === 'card' ? 'Card' : m === 'credit' ? 'Credit Note' : 'Other';
                  return (
                    <button key={m} onClick={() => setReturnRefundMethod(m)} className="cursor-pointer rounded"
                      style={{ padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{label}</button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PRODUCT DISPOSITION</span>
              {(() => {
                // Plan §Commission §13: wenn Consignment-Ware zurückkommt, zwei zusätzliche Optionen.
                const includedLineIds = Object.keys(returnLines).filter(k => returnLines[k].include);
                const includedProductIds = invoice.lines.filter(l => includedLineIds.includes(l.id)).map(l => l.productId);
                const hasConsignment = products.some(p => includedProductIds.includes(p.id) && p.sourceType === 'CONSIGNMENT');
                const options: { id: ProductDisposition; label: string; hint?: string }[] = [
                  { id: 'IN_STOCK', label: 'Back to Stock' },
                  { id: 'UNDER_REPAIR', label: 'Under Repair' },
                  { id: 'WRITE_OFF', label: 'Write Off' },
                ];
                if (hasConsignment) {
                  options.push({ id: 'RETURN_TO_OWNER', label: 'Return to Owner', hint: 'Plan §Commission §13A' });
                  options.push({ id: 'KEEP_AS_OWN', label: 'Keep (→ OWN)', hint: 'Plan §Commission §13B — purchase_price = sale_price' });
                }
                return (
                  <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                    {options.map(d => {
                      const active = returnDisposition === d.id;
                      return (
                        <button key={d.id} onClick={() => setReturnDisposition(d.id)} className="cursor-pointer rounded"
                          title={d.hint}
                          style={{ padding: '7px 12px', fontSize: 11,
                            border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                            color: active ? '#0F0F10' : '#6B7280',
                            background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}>{d.label}</button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>

          <Input label="REASON FOR RETURN (optional)" placeholder="z.B. defekt, falsche Ware, Reklamation"
            value={returnReason} onChange={e => setReturnReason(e.target.value)} />
          <Input label="ADDITIONAL NOTES" placeholder="interne Vermerke" value={returnNotes} onChange={e => setReturnNotes(e.target.value)} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>REFUND TIMING</span>
            <div className="flex gap-2">
              {[
                { id: true, label: 'Refund jetzt zahlen' },
                { id: false, label: 'Refund später (Status: Not Refunded)' },
              ].map(o => (
                <button key={String(o.id)} onClick={() => setReturnRefundNow(o.id)}
                  className="cursor-pointer rounded"
                  style={{ padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${returnRefundNow === o.id ? '#0F0F10' : '#D5D9DE'}`,
                    color: returnRefundNow === o.id ? '#0F0F10' : '#6B7280',
                    background: returnRefundNow === o.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{o.label}</button>
              ))}
            </div>
          </div>

          {(() => {
            const returnTotal = invoice.lines.reduce((s, l) => {
              const r = returnLines[l.id];
              if (r?.include) return s + r.quantity * r.unitPrice;
              return s;
            }, 0);
            const customerPaid = invoice.paidAmount || 0;
            const grossAmount = invoice.grossAmount || 0;
            // Industriestandard: Cash zurück nur wenn Customer NACH Return mehr gezahlt hat als er noch schuldet.
            const owedAfterReturn = Math.max(0, grossAmount - returnTotal);
            const cashRefund = Math.max(0, customerPaid - owedAfterReturn);
            const receivableCancel = Math.max(0, returnTotal - cashRefund);
            return (
              <div style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                <div className="flex justify-between" style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 14, color: '#6B7280' }}>Return Total</span>
                  <span className="font-mono" style={{ fontSize: 16, color: '#DC2626' }}>{fmt(returnTotal)} BHD</span>
                </div>
                {returnTotal > 0 && (
                  <div style={{ fontSize: 11, color: '#6B7280', lineHeight: 1.6, padding: '8px 10px', background: '#F2F7FA', borderRadius: 6, marginTop: 8 }}>
                    <div className="flex justify-between"><span>Cash refund (back to customer)</span><span className="font-mono" style={{ color: cashRefund > 0 ? '#DC2626' : '#0F0F10' }}>{fmt(cashRefund)} BHD</span></div>
                    <div className="flex justify-between" style={{ marginTop: 2 }}><span>Receivable cancellation (Credit Note)</span><span className="font-mono" style={{ color: receivableCancel > 0 ? '#FF8730' : '#0F0F10' }}>{fmt(receivableCancel)} BHD</span></div>
                    {customerPaid === 0 && returnTotal > 0 && (
                      <div style={{ marginTop: 6, color: '#FF8730', fontStyle: 'italic' }}>
                        ℹ Customer hasn't paid yet — no cash flows back, only the receivable is cancelled via Credit Note.
                      </div>
                    )}
                    {customerPaid > 0 && cashRefund === 0 && returnTotal > 0 && (
                      <div style={{ marginTop: 6, color: '#FF8730', fontStyle: 'italic' }}>
                        ℹ Customer still owes {fmt(owedAfterReturn - customerPaid)} BHD after the return — no cash refund, only Credit Note offsets the receivable.
                      </div>
                    )}
                    {cashRefund > 0 && cashRefund < returnTotal && (
                      <div style={{ marginTop: 6, color: '#FF8730', fontStyle: 'italic' }}>
                        ℹ Cash refund = surplus customer paid above remaining debt; rest is Credit Note.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowReturn(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateSalesReturn}
              disabled={!Object.values(returnLines).some(r => r.include)}>Confirm Return &amp; Refund</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
