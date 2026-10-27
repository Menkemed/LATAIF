import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Save, Trash2, AlertTriangle, FileText, Receipt, ShoppingBag, Package } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
// CONSIGNMENT MULTI-SALE — der EINE Verkaufsdialog (Käufer mit „+ New Client", Zahlungen, Verkaufstag = Rechnungsdatum).
import { ConsignmentSaleDialog } from '@/components/consignments/ConsignmentSaleDialog';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { CollectionProductThumb } from '@/components/products/CollectionProductThumb';
import { useMediaScope } from '@/hooks/useMediaScope';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { usePermission } from '@/hooks/usePermission';
import { useSharedWrites, nichtAmClient, fehlertext } from '@/core/data/shared-write';
import { primaryOnlyDeleteProps, blockDeleteOnClient } from '@/core/data/primary-only';
import { WriteError } from '@/components/shared/WriteError';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { Bhd } from '@/components/ui/Bhd';
import { getProductSpecs } from '@/core/utils/product-format';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { computeConsignmentSale, commissionLineLabel, commissionModelLabel } from '@/core/consignment/economics';
import { consignorOpenFor } from '@/core/consignment/consignor-side';
import { PAYOUT_MODELS, payoutModelLock, payoutFieldsFor, normalizePayoutModel, bookedCommissionInput, HISTORICAL_MARGIN_LABEL } from '@/core/consignment/payout-edit';
import {
  CONSIGNMENT_PAYOUT_METHODS, consignmentPayoutBody, payoutOpenAmount,
} from '@/core/consignment/consignment-finance';
import {
  cancelConsignmentSaleOnPrimary, payOutConsignmentOnPrimary, returnConsignmentAfterSaleOnPrimary,
} from '@/core/consignment/consignment-finance-house';
// R6F — Rückgabe nach dem Verkauf und Verkaufsstorno: Wege und Rümpfe aus EINER Quelle.
import {
  CONSIGNOR_REFUND_METHODS, DEFAULT_POST_SALE_REFUND_METHOD, POST_SALE_REFUND_METHODS, consignmentCancelSaleBody,
  consignmentReturnAfterSaleBody,
  type ConsignmentReturnAfterSaleInput, type ConsignorRefundChoice, type ConsignorRefundMethod, type PostSaleDisposition,
} from '@/core/consignment/consignment-reversal';
import type { ReturnRefundMethod } from '@/core/returns/return-create';
import { productDisplayName } from '@/core/products/display-name';

const REFUND_LABEL: Record<ReturnRefundMethod, string> = {
  cash: 'Cash', bank: 'Bank Transfer', card: 'Card', benefit: 'Benefit', credit: 'Store Credit', other: 'Other',
};
/** D3 — wie das Geld des Einlieferers zurückkam. */
const CONSIGNOR_REFUND_LABEL: Record<ConsignorRefundMethod, string> = { cash: 'Cash', bank: 'Bank Transfer', benefit: 'Benefit' };

/** D3 — die Wahl des Owners, was mit einer schon geleisteten Auszahlung geschieht (Return to Owner / Cancel Sale). */
function ConsignorRefundPicker({ paid, name, value, onChange, testId }: {
  paid: number; name: string; value: ConsignorRefundChoice; onChange: (v: ConsignorRefundChoice) => void; testId: string;
}) {
  const received = value.mode === 'received';
  const method: ConsignorRefundMethod = value.mode === 'received' ? value.method : 'cash';
  const knopf = (on: boolean) => ({
    padding: '7px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
    border: `1px solid ${on ? '#0F0F10' : '#D5D9DE'}`, color: on ? '#0F0F10' : '#6B7280',
    background: on ? 'rgba(15,15,16,0.06)' : 'transparent',
  });
  return (
    <div data-consignor-refund={testId} style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(255,135,48,0.06)', border: '1px solid rgba(255,135,48,0.30)', fontSize: 12, color: '#7A4A20' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{name} was already paid <Bhd v={paid}/> BHD for this item.</div>
      <div style={{ marginBottom: 8 }}>The payout stays in the books. What happens with that money now?</div>
      <div className="flex flex-wrap gap-2" style={{ marginBottom: 8 }}>
        <button type="button" data-consignor-refund-mode="received" onClick={() => onChange({ mode: 'received', method })} style={knopf(received)}>
          Money came back now
        </button>
        <button type="button" data-consignor-refund-mode="pending" onClick={() => onChange({ mode: 'pending' })} style={knopf(!received)}>
          Repayment still open
        </button>
      </div>
      {received ? (
        <div className="flex flex-wrap gap-2 items-center">
          <span>Received as:</span>
          {CONSIGNOR_REFUND_METHODS.map((m) => (
            <button key={m} type="button" data-consignor-refund-method={m} onClick={() => onChange({ mode: 'received', method: m })} style={knopf(method === m)}>
              {CONSIGNOR_REFUND_LABEL[m]}
            </button>
          ))}
          <span style={{ color: '#6B7280' }}>— booked today as money in.</span>
        </div>
      ) : (
        <div style={{ color: '#6B7280', lineHeight: 1.5 }}>
          No money is booked. <Bhd v={paid}/> BHD stays open as the consignor&apos;s supplier credit (he owes it to us) and can be
          offset against his next payouts. Recording a later cash repayment waits for the accountant&apos;s booking rule.
        </div>
      )}
    </div>
  );
}

function daysUntil(dateStr: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function ConsignmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/consignments');
  const {
    consignments, loadConsignments, updateConsignment, updateConsignmentPayoutModel,
    markReturned, deleteConsignment,
  } = useConsignmentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const { tenantId: mediaTenantId, branchId: mediaBranchId } = useMediaScope();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  const { expenses, loadExpenses } = useExpenseStore();
  const { employees, loadEmployees } = useEmployeeStore();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    agreedPrice: string;
    minimumPrice: string;
    commissionRate: string;
    payoutModel: 'percent' | 'consignor_fixed' | 'cost_split';
    excessSplitPct: string;
    expiryDate: string;
    notes: string;
  }>({ agreedPrice: '', minimumPrice: '', commissionRate: '', payoutModel: 'percent', excessSplitPct: '', expiryDate: '', notes: '' });
  const [editError, setEditError] = useState('');

  // Modals
  const [soldModal, setSoldModal] = useState(false);
  const [paidModal, setPaidModal] = useState(false);
  const [paidMethod, setPaidMethod] = useState('bank_transfer');
  const [paidRef, setPaidRef] = useState('');
  const [returnModal, setReturnModal] = useState(false);
  const [postSaleReturnModal, setPostSaleReturnModal] = useState(false);
  const [postSaleDisposition, setPostSaleDisposition] = useState<PostSaleDisposition>('RETURN_TO_OWNER');
  // R6F — die übrige Wahl des Dialogs: wie der Käufer sein Geld zurückbekommt (nur wenn er bezahlt hat) und warum.
  const [postSaleRefundMethod, setPostSaleRefundMethod] = useState<ReturnRefundMethod>(DEFAULT_POST_SALE_REFUND_METHOD);
  const [postSaleReason, setPostSaleReason] = useState('');
  // D3 — was mit der schon geleisteten Auszahlung geschieht (Return to Owner), und je Kommission beim Cancel Sale.
  const [postSaleConsignorRefund, setPostSaleConsignorRefund] = useState<ConsignorRefundChoice>({ mode: 'received', method: 'cash' });
  const [cancelRefunds, setCancelRefunds] = useState<Record<string, ConsignorRefundChoice>>({});
  const [cancelSaleModal, setCancelSaleModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const perm = usePermission();
  // CONSIGNMENT MULTI-SALE — der Dialog bekommt die Kommission dieser Seite als (einzige) Auswahl.
  const saleIds = useMemo(() => (id ? [id] : []), [id]);

  useEffect(() => {
    loadConsignments();
    loadCustomers();
    loadProducts();
    loadCategories();
    loadInvoices();
    loadPurchases();
    loadExpenses();
    loadEmployees();
  }, [loadConsignments, loadCustomers, loadProducts, loadCategories, loadInvoices, loadPurchases, loadExpenses, loadEmployees]);

  // CENTRAL-UI-PARITY R4C — dieselbe Maske, zwei Anschluesse hinter jeder Handlung.
  const w = useSharedWrites();
  const consignment = useMemo(
    () => consignments.find(c => c.id === id),
    [consignments, id],
  );

  const consignor = useMemo(
    () => consignment ? customers.find(c => c.id === consignment.consignorId) : null,
    [consignment, customers],
  );

  const product = useMemo(
    () => consignment ? products.find(p => p.id === consignment.productId) : null,
    [consignment, products],
  );

  const buyer = useMemo(
    () => consignment?.buyerId ? customers.find(c => c.id === consignment.buyerId) : null,
    [consignment, customers],
  );

  // Linked records (für Sold-Card Anzeige).
  // WICHTIG: useMemo MUSS vor dem `if (!consignment) return ...` stehen — sonst
  // springt die Hook-Anzahl zwischen Renders und React explodiert mit
  // "Rendered more hooks than during the previous render".
  const linkedPurchase = useMemo(() => {
    if (!consignment) return null;
    if (consignment.status !== 'sold' && consignment.status !== 'paid_out') return null;
    // PURCHASE-EDIT B6 — die Spalte zuerst; der Vermerk nur für einen Altbestand ohne Spalte.
    return purchases.find(p => p.sourceConsignmentId === consignment.id && p.status !== 'CANCELLED')
      || purchases.find(p => !p.sourceConsignmentId && p.status !== 'CANCELLED' && (p.notes || '').includes(consignment.consignmentNumber)) || null;
  }, [purchases, consignment]);
  // D2 — die Kommissionen DESSELBEN Verkaufs (eine Rechnung): Cancel Sale nimmt sie alle zurück.
  const saleGroup = useMemo(() => {
    if (!consignment?.invoiceId) return consignment ? [consignment] : [];
    return consignments.filter(c => c.invoiceId === consignment.invoiceId)
      .sort((a, b) => a.consignmentNumber.localeCompare(b.consignmentNumber));
  }, [consignments, consignment]);
  const linkedLossExpense = useMemo(() => {
    if (!consignment) return null;
    if (consignment.status !== 'sold' && consignment.status !== 'paid_out') return null;
    return expenses.find(e =>
      e.relatedModule === 'consignment' && e.relatedEntityId === consignment.id && e.category === 'ConsignorLoss'
    ) || null;
  }, [expenses, consignment]);

  // Sync form when consignment loads
  useEffect(() => {
    if (consignment) {
      setForm({
        agreedPrice: String(consignment.agreedPrice),
        minimumPrice: consignment.minimumPrice != null ? String(consignment.minimumPrice) : '',
        commissionRate: String(consignment.commissionRate),
        payoutModel: normalizePayoutModel(consignment.commissionType),
        excessSplitPct: consignment.excessSplitPct != null ? String(consignment.excessSplitPct) : '',
        expiryDate: consignment.expiryDate || '',
        notes: consignment.notes || '',
      });
    }
  }, [consignment]);

  if (!consignment) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Consignment not found</p>
      </div>
    );
  }

  // Expiry warning
  const expiryDays = consignment.expiryDate ? daysUntil(consignment.expiryDate) : null;
  const expiryWarning = expiryDays !== null && expiryDays <= 14 && consignment.status === 'active';

  // Live edit calculations
  const editAgreed = Number(form.agreedPrice) || 0;
  // Die Vorschau rechnet mit der ECHTEN Oekonomie des gewaehlten Modells statt mit der
  // Prozentformel — sonst zeigte sie fuer "Agreed + Excess" und "Cost + Split" Zahlen, die beim
  // Verkauf nie entstehen. Verkaufspreis = Agreed Price (bei cost_split der Kost) = Breakeven.
  const editEcon = (() => {
    const input = {
      commissionType: form.payoutModel,
      commissionRate: Number(form.commissionRate) || 0,
      agreedPrice: editAgreed,
      excessSplitPct: form.excessSplitPct === '' ? undefined : Number(form.excessSplitPct),
    };
    return { input, result: computeConsignmentSale(input, editAgreed) };
  })();
  // Die Sperre entscheidet der Kern, nicht dieser Bildschirm — dieselbe Funktion, die auch der
  // Store vor dem Schreiben fragt.
  const payoutLock = payoutModelLock(consignment);
  const payoutFields = payoutFieldsFor(form.payoutModel);
  // Fuer eine bereits gebuchte Marge: der eingefrorene Stand, sonst der heutige.
  const bookedLabelInput = bookedCommissionInput(consignment);

  // D3 — was der Einlieferer für diesen Verkauf schon bekam (bar und per Guthaben, über seinen Einkauf).
  const consignorPaid = consignment.consignorSide?.paid ?? 0;

  // Linked invoice (no useMemo needed — simple lookup, can stay after early return).
  const linkedInvoice = consignment.invoiceId ? invoices.find(i => i.id === consignment.invoiceId) : null;

  async function handleSave() {
    if (!id || !consignment) return;
    setEditError('');
    const fassung = consignment.revision;
    if (w.remote && !fassung) { setEditError(fehlertext(nichtAmClient('editing this consignment (no revision loaded)'))); return; }
    const stamm = {
      agreedPrice: Number(form.agreedPrice) || consignment.agreedPrice,
      minimumPrice: form.minimumPrice ? Number(form.minimumPrice) : undefined,
      expiryDate: form.expiryDate || undefined,
      notes: form.notes || undefined,
    };
    const modell = payoutLock.locked ? undefined : {
      model: form.payoutModel,
      commissionRate: form.commissionRate,
      excessSplitPct: form.excessSplitPct,
    };
    {
      if (!await w.ok('consignments.update', {
        local: () => {
          // Zwei getrennte Vertraege, bewusst in dieser Reihenfolge: das Auszahlungsmodell zuerst,
          // weil es scheitern DARF. Genau diese Reihenfolge faehrt auch die Fernbuchung.
          if (modell) updateConsignmentPayoutModel(id, modell);
          updateConsignment(id, stamm);
          return {};
        },
        remote: () => ({
          id, expectedRevision: fassung,
          ...(stamm.agreedPrice !== undefined ? { agreedPrice: stamm.agreedPrice } : {}),
          ...(stamm.minimumPrice !== undefined ? { minimumPrice: stamm.minimumPrice } : {}),
          ...(stamm.expiryDate !== undefined ? { expiryDate: stamm.expiryDate } : {}),
          ...(stamm.notes !== undefined ? { notes: stamm.notes } : {}),
          ...(modell ? { payout: modell } : {}),
        }),
      })) { setEditError(w.fehler); return; }
      loadConsignments();
      setEditing(false);
      return;
    }
  }


  async function handleMarkPaid() {
    if (!id || !consignment) return;
    const fassung = consignment.revision;
    if (w.remote && !fassung) { w.clear(); alert(fehlertext(nichtAmClient('paying out this consignment (no revision loaded)'))); return; }
    // R5F — die Maske zahlt den offenen Rest, den sie gesehen hat. Status, Rest und Buchung schreibt
    // das Haus: nur ohne Rechnung, nie mehr als offen, erst der Rest auf null schliesst.
    const input = { amount: payoutOpenAmount(consignment), method: paidMethod, reference: paidRef || undefined };
    if (!await w.ok('consignments.record_payout', {
      local: () => payOutConsignmentOnPrimary(id, input),
      remote: () => consignmentPayoutBody(id, Number(fassung), input),
    })) return;
    loadConsignments();
    setPaidModal(false);
    setPaidMethod('bank_transfer');
    setPaidRef('');
  }

  // R4C — bestandswirksam: der Artikel geht zurueck an den Eigentuemer und aus dem Bestand.
  // Fassungsbasiert, damit ein zwischenzeitlicher Verkauf nicht ueberschrieben wird.
  async function handleReturn() {
    if (!id || !consignment) return;
    const fassung = consignment.revision;
    if (w.remote && !fassung) { alert(fehlertext(nichtAmClient('returning this consignment (no revision loaded)'))); return; }
    if (!await w.ok('consignments.mark_returned', {
      local: () => { markReturned(id); return {}; },
      remote: () => ({ consignmentId: id, expectedRevision: fassung }),
    })) return;
    loadConsignments();
    setReturnModal(false);
  }

  // R6F — nach einer Rücknahme ändern sich Kommission, Rechnung, Einkauf, Ausgabe, Artikel und Kunde.
  function reloadAfterReversal() {
    loadConsignments();
    loadInvoices();
    loadPurchases();
    loadExpenses();
    loadProducts();
    loadCustomers();
  }

  // R6F — „Buyer Returns the Item": die Wahl des Dialogs geht über EINE Buchung. Retoure, Gutschrift,
  // Erstattung, Wareneinsatz, Einkauf des Einlieferers und Status schreibt das Haus in EINER Klammer —
  // am Primary wie fern; die gesehene Fassung wacht gegen einen zwischenzeitlichen Storno.
  async function handlePostSaleReturn() {
    if (!id || !consignment) return;
    const fassung = consignment.revision;
    if (w.remote && !fassung) { w.clear(); alert(fehlertext(nichtAmClient('returning this sale (no revision loaded)'))); return; }
    const input: ConsignmentReturnAfterSaleInput = { disposition: postSaleDisposition };
    // Ohne erhaltenes Geld fließt nichts zurück — dann gibt es auch keinen Weg zu wählen.
    if ((linkedInvoice?.paidAmount || 0) > 0.005) input.refundMethod = postSaleRefundMethod;
    // D3 — geht die Ware an einen schon bezahlten Einlieferer zurück, sagt der Owner, was mit dem Geld geschieht.
    if (postSaleDisposition === 'RETURN_TO_OWNER' && consignorPaid > 0.0005) input.consignorRefund = postSaleConsignorRefund;
    if (postSaleReason.trim()) input.reason = postSaleReason.trim();
    if (!await w.ok('consignments.return_after_sale', {
      local: () => returnConsignmentAfterSaleOnPrimary(id, input),
      remote: () => consignmentReturnAfterSaleBody(id, Number(fassung), input),
    })) return;
    reloadAfterReversal();
    setPostSaleReturnModal(false);
    setPostSaleReason('');
  }

  // R6F — „Cancel Sale": WELCHE Kommission in welcher Fassung — Rechnung, Retoure, Einkauf, Ausgabe,
  // Auszahlungen und Bestand findet das Haus selbst. Kein lokaler try/alert-Pfad mehr.
  async function handleCancelSale() {
    if (!id || !consignment) return;
    const fassung = consignment.revision;
    if (w.remote && !fassung) { w.clear(); alert(fehlertext(nichtAmClient('cancelling this sale (no revision loaded)'))); return; }
    // D3 — nur für die schon bezahlten Einlieferer des Verkaufs (je Kommission die Wahl im Dialog).
    const erstattung = Object.fromEntries(saleGroup
      .filter(c => (c.consignorSide?.paid ?? 0) > 0.0005 && c.invoiceId)
      .map(c => [c.id, cancelRefunds[c.id] ?? { mode: 'received', method: 'cash' }]));
    if (!await w.ok('consignments.cancel_sale', {
      local: () => cancelConsignmentSaleOnPrimary(id, erstattung),
      remote: () => consignmentCancelSaleBody(id, Number(fassung), erstattung),
    })) return;
    reloadAfterReversal();
    setCancelSaleModal(false);
  }

  function handleDelete() {
    if (!id) return;
    if (blockDeleteOnClient()) { setConfirmDelete(false); return; }
    deleteConsignment(id);
    navigate('/consignments');
  }

  const consignorName = consignor
    ? `${consignor.firstName} ${consignor.lastName}`
    : '\u2014';

  const productLabel = product
    ? productDisplayName(product)
    : '\u2014';

  // 2026-05-18: Layout neu im Transfer-Detail-Stil (KPI-Strip / Action-Bar /
  // Item+Consignor-Row / Meta-Footer). Edit ist jetzt ein Modal statt Inline.
  // D4 — was wir dem Einlieferer für diesen Verkauf noch schulden: aus SEINEM Einkauf (und einer offenen
  // Verlust-Ausgabe), beim Altweg aus der Kommission — dieselbe Ableitung wie Liste und Einlieferer-Seite.
  const outstandingPayout = consignorOpenFor(consignment);
  const consignmentSubtitle = `Consignor: ${consignorName}`;
  const transferredDate = consignment.agreementDate || (consignment.createdAt || '').split('T')[0];
  const soldOnDate = consignment.status === 'sold' && consignment.updatedAt
    ? consignment.updatedAt.split('T')[0]
    : '';
  const returnedOnDate = (consignment.status === 'returned' || consignment.status === 'paid_out') && consignment.updatedAt
    ? consignment.updatedAt.split('T')[0]
    : '';

  function openEditModal() {
    setForm({
      agreedPrice: String(consignment!.agreedPrice),
      minimumPrice: consignment!.minimumPrice != null ? String(consignment!.minimumPrice) : '',
      commissionRate: String(consignment!.commissionRate),
      // Das GESPEICHERTE Modell ist vorausgewaehlt, samt seinem Parameter — sonst begaenne jeder
      // Edit stillschweigend bei "percent" und schriebe das beim Speichern fest.
      payoutModel: normalizePayoutModel(consignment!.commissionType),
      excessSplitPct: consignment!.excessSplitPct != null ? String(consignment!.excessSplitPct) : '',
      expiryDate: consignment!.expiryDate || '',
      notes: consignment!.notes || '',
    });
    setEditError('');
    setEditing(true);
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      {/* R4C — der Ausgang jeder Handlung dieser Seite, an einer Stelle. */}
      <WriteError text={w.fehler} />
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>

        {/* Back */}
        <button onClick={goBack}
          className="flex items-center gap-2 cursor-pointer transition-colors"
          style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13, marginBottom: 12 }}
          onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
          onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
        >
          <ArrowLeft size={16} /> Back
        </button>

        {/* Title */}
        <div style={{ marginBottom: 18 }}>
          <h1 className="font-display" style={{ fontSize: 26, color: '#0F0F10', lineHeight: 1.2 }}>
            Consignment {consignment.consignmentNumber}
          </h1>
          <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{consignmentSubtitle}</p>
        </div>

        {/* Hero KPI Card — Agreed · Sale · Payout · Outstanding */}
        <Card style={{ padding: 18, marginBottom: 18 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
            <div className="flex items-center gap-3">
              <span className="font-mono" style={{ fontSize: 15, color: '#0F0F10', fontWeight: 600 }}>
                {consignment.consignmentNumber}
              </span>
              <StatusDot status={consignment.status} />
              {consignment.payoutStatus !== 'pending' && consignment.status !== 'active' && (
                <StatusDot status={consignment.payoutStatus} label={`Payout: ${consignment.payoutStatus.replace(/_/g, ' ')}`} />
              )}
            </div>
            <span style={{ fontSize: 11, color: '#9CA3AF' }}>
              consigned {transferredDate || '—'}
              {soldOnDate && ` · sold ${soldOnDate}`}
              {returnedOnDate && consignment.status === 'returned' && ` · returned ${returnedOnDate}`}
              {returnedOnDate && consignment.status === 'paid_out' && ` · paid out ${returnedOnDate}`}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Agreed Price', value: consignment.agreedPrice || 0, color: '#4B5563' },
              { label: 'Sale Price', value: consignment.salePrice ?? 0, color: '#0F0F10' },
              { label: 'Payout', value: consignment.payoutAmount ?? 0, color: (consignment.payoutAmount ?? 0) > 0 ? '#16A34A' : '#6B7280' },
              { label: 'Outstanding Payout', value: outstandingPayout, color: outstandingPayout > 0 ? '#DC2626' : '#6B7280' },
            ].map(k => (
              <div key={k.label} style={{
                padding: '10px 12px', borderRadius: 8,
                background: '#FAFBFC', border: '1px solid #E5E9EE',
              }}>
                <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                  {k.label}
                </div>
                <div className="font-mono" style={{ fontSize: 16, color: k.color, fontWeight: 600 }}>
                  <Bhd v={k.value} /> <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 400 }}>BHD</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Actions Card — Status-abhaengige Buttons; Delete rechts */}
        {perm.canManageConsignments && (
          <Card style={{ padding: 14, marginBottom: 18 }}>
            <div className="flex flex-wrap gap-2">
              {consignment.status === 'active' && (
                <>
                  <Button variant="primary" onClick={() => setSoldModal(true)}>
                    Record Sale
                  </Button>
                  <Button variant="ghost" onClick={() => setReturnModal(true)}>Return</Button>
                </>
              )}
              {consignment.status === 'sold' && (
                <>
                  {consignment.invoiceId && linkedInvoice && (
                    <Button variant="primary" onClick={() => navigate(`/invoices/${consignment.invoiceId}`)}>
                      <FileText size={14} /> Open Invoice ({formatInvoiceDisplayShort(linkedInvoice)})
                    </Button>
                  )}
                  {linkedPurchase && (
                    <Button variant="secondary" onClick={() => navigate(`/purchases/${linkedPurchase.id}`)}>
                      <ShoppingBag size={14} /> Consignor Purchase
                    </Button>
                  )}
                  {!consignment.invoiceId && (
                    <Button variant="primary" onClick={() => setPaidModal(true)}>Pay Out (legacy)</Button>
                  )}
                  <Button variant="ghost" onClick={() => { w.clear(); setPostSaleReturnModal(true); }} data-consignment-return-after-sale>Post-Sale Return</Button>
                  {consignment.invoiceId && (
                    <Button variant="ghost" onClick={() => { w.clear(); setCancelSaleModal(true); }} data-consignment-cancel-sale>Cancel Sale</Button>
                  )}
                </>
              )}
              {consignment.status === 'returned' && consignment.invoiceId && (
                <Button variant="ghost" onClick={() => { w.clear(); setCancelSaleModal(true); }} data-consignment-cancel-sale>Cancel Sale (cleanup)</Button>
              )}
              {consignment.status === 'paid_out' && (
                <>
                  <Button variant="ghost" onClick={() => { w.clear(); setPostSaleReturnModal(true); }} data-consignment-return-after-sale>Post-Sale Return</Button>
                  {/* paid_out-Teardown: bewusst OHNE invoiceId-Bedingung — die real
                      existierende paid_out-Population stammt aus dem Legacy-Pfad
                      (markPaidOut ohne Invoice); die Hausfolge deckt beide Fälle
                      (dieselbe Regel: `cancelSaleBlocker`). */}
                  <Button variant="ghost" onClick={() => { w.clear(); setCancelSaleModal(true); }} data-consignment-cancel-sale>Cancel Sale</Button>
                </>
              )}
              <Button variant="ghost" onClick={openEditModal}>
                <Edit3 size={14} /> Edit
              </Button>
              <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
              <div style={{ flex: 1 }} />
              {consignment.status === 'active' && (
                <Button variant="ghost" {...primaryOnlyDeleteProps()} onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} color="#DC2626" /> <span style={{ color: '#DC2626' }}>Delete</span>
                </Button>
              )}
            </div>
          </Card>
        )}

        {/* Item + Consignor — 2-Col Row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>

          {/* Item Card */}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Item</span>
            </div>
            <div style={{ padding: 14 }}>
              <div className="flex items-start gap-4" style={{ minWidth: 0 }}>
                <div
                  className={product ? 'cursor-pointer' : ''}
                  onClick={() => product && navigate(`/collection/${product.id}`)}
                  style={{
                    width: 96, height: 96, borderRadius: 10,
                    background: '#F2F7FA', border: '1px solid #E5E9EE',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden', flexShrink: 0,
                  }}>
                {product ? (
                  <CollectionProductThumb
                    product={product}
                    tenantId={mediaTenantId}
                    branchId={mediaBranchId}
                    imgStyle={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    iconSize={28}
                    iconColor="#9CA3AF"
                    iconStrokeWidth={1.2}
                  />
                ) : (
                  <Package size={28} strokeWidth={1.2} style={{ color: '#9CA3AF' }} />
                )}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                  Product
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#0F0F10', lineHeight: 1.25 }}>
                  {productLabel}
                </div>
                {product?.sku && (
                  <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 4 }}>{product.sku}</span>
                )}
                {(() => {
                  const specs = product ? getProductSpecs(product, categories, { includeSku: false }) : [];
                  if (specs.length === 0) return null;
                  return (
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      columnGap: 14, rowGap: 3,
                      marginTop: 10, fontSize: 11,
                    }}>
                      {specs.slice(0, 8).map((s, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                          <span style={{ color: '#9CA3AF' }}>{s.label}:</span>
                          <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.value}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Expiry Warning — bleibt im Item-Card als kompakter Banner */}
            {expiryWarning && (
              <div className="flex items-center gap-2" style={{
                marginTop: 14, padding: '8px 12px', borderRadius: 8,
                background: expiryDays! <= 0 ? 'rgba(220,38,38,0.08)' : 'rgba(15,15,16,0.06)',
                border: `1px solid ${expiryDays! <= 0 ? '#AA6E6E30' : '#0F0F1030'}`,
              }}>
                <AlertTriangle size={14} style={{ color: expiryDays! <= 0 ? '#AA6E6E' : '#0F0F10' }} />
                <span style={{ fontSize: 12, color: expiryDays! <= 0 ? '#AA6E6E' : '#0F0F10' }}>
                  {expiryDays! <= 0
                    ? `Expired ${Math.abs(expiryDays!)} day${Math.abs(expiryDays!) !== 1 ? 's' : ''} ago`
                    : `Expires in ${expiryDays} day${expiryDays !== 1 ? 's' : ''}`}
                </span>
              </div>
            )}
            </div>
          </Card>

          {/* Consignor Card */}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Consignor / Customer</span>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {consignor ? (
                <>
                  <button
                    onClick={() => navigate(`/consignors/${consignor.id}`)}
                    className="cursor-pointer"
                    style={{
                      background: 'none', border: 'none', padding: 0, textAlign: 'left',
                      color: '#715DE3', fontSize: 15, fontWeight: 600,
                      textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3,
                    }}
                    title="Open consignor profile"
                  >
                    {consignorName}
                  </button>
                  {consignor.company && <span style={{ fontSize: 12, color: '#4B5563' }}>{consignor.company}</span>}
                  {consignor.phone && <span style={{ fontSize: 12, color: '#4B5563' }}>Phone: {consignor.phone}</span>}
                  {consignor.email && <span style={{ fontSize: 12, color: '#4B5563' }}>Email: {consignor.email}</span>}
                  <div style={{ borderTop: '1px solid #F0F2F5', paddingTop: 8, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                    <div className="flex justify-between">
                      <span style={{ color: '#6B7280' }}>Agreement Date</span>
                      <span style={{ color: '#0F0F10' }}>{consignment.agreementDate || '—'}</span>
                    </div>
                    {consignment.expiryDate && (
                      <div className="flex justify-between">
                        <span style={{ color: '#6B7280' }}>Expiry Date</span>
                        <span style={{ color: expiryWarning ? (expiryDays! <= 0 ? '#AA6E6E' : '#0F0F10') : '#0F0F10' }}>
                          {consignment.expiryDate}
                        </span>
                      </div>
                    )}
                    {consignment.staffId && (() => {
                      const e = employees.find(x => x.id === consignment.staffId);
                      if (!e) return null;
                      return (
                        <div className="flex justify-between">
                          <span style={{ color: '#6B7280' }}>Received by</span>
                          <span
                            className="cursor-pointer"
                            onClick={() => navigate(`/employees/${e.id}`)}
                            style={{ color: '#715DE3', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                          >{e.name}{e.role ? ` · ${e.role}` : ''}</span>
                        </div>
                      );
                    })()}
                  </div>
                </>
              ) : (
                <span style={{ fontSize: 12, color: '#9CA3AF' }}>Consignor not found.</span>
              )}
            </div>
          </Card>
        </div>

        {/* Status-dependent: Sale Breakdown + Linked Records (Plan 2026-05) */}
        {(consignment.status === 'sold' || consignment.status === 'paid_out') && consignment.salePrice != null && (
          <Card style={{ padding: 14, marginBottom: 18 }}>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>Sale Breakdown</span>
            <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: '#6B7280' }}>Sale Price</span>
              <span className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}><Bhd v={consignment.salePrice}/> BHD</span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
              {/* Die Beschriftung eines GEBUCHTEN Verkaufs nennt die damalige Basis, nicht die
                  heutige: der Agreed Price bleibt danach aenderbar, die Buchung daneben nicht. */}
              <span data-booked-margin-label style={{ color: '#6B7280' }}>
                {bookedLabelInput ? commissionLineLabel(bookedLabelInput) : HISTORICAL_MARGIN_LABEL}
              </span>
              <span className="font-mono" style={{ color: (consignment.commissionAmount || 0) < 0 ? '#DC2626' : '#0F0F10' }}>
                <Bhd v={consignment.commissionAmount || 0}/> BHD
              </span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 13, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <span style={{ color: '#6B7280' }}>Payout Amount</span>
              <span className="font-mono" style={{ color: '#7EAA6E', fontSize: 16 }}><Bhd v={consignment.payoutAmount || 0}/> BHD</span>
            </div>
            {buyer && (
              <div className="flex justify-between" style={{ fontSize: 13, marginTop: 8 }}>
                <span style={{ color: '#6B7280' }}>Buyer</span>
                <span style={{ color: '#0F0F10' }}>{buyer.firstName} {buyer.lastName}</span>
              </div>
            )}

            {(linkedInvoice || linkedPurchase || linkedLossExpense) && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                <span className="text-overline" style={{ marginBottom: 10, display: 'block' }}>Linked Records</span>
                {linkedInvoice && (
                  <button onClick={() => navigate(`/invoices/${linkedInvoice.id}`)}
                    className="cursor-pointer flex items-center justify-between w-full"
                    style={{
                      padding: '8px 10px', marginBottom: 6, fontSize: 12,
                      borderRadius: 6, border: '1px solid #E5E9EE', background: 'transparent',
                    }}>
                    <span className="flex items-center gap-2" style={{ color: '#0F0F10' }}>
                      <FileText size={13} style={{ color: '#715DE3' }} /> Buyer Invoice
                      <span className="font-mono" style={{ color: '#3D7FFF', marginLeft: 4 }}>{formatInvoiceDisplayShort(linkedInvoice)}</span>
                    </span>
                    <span className="font-mono" style={{ color: linkedInvoice.paidAmount >= linkedInvoice.grossAmount ? '#16A34A' : '#DC2626' }}>
                      <Bhd v={linkedInvoice.grossAmount - linkedInvoice.paidAmount}/> BHD remaining
                    </span>
                  </button>
                )}
                {linkedPurchase && (
                  <button onClick={() => navigate(`/purchases/${linkedPurchase.id}`)}
                    className="cursor-pointer flex items-center justify-between w-full"
                    style={{
                      padding: '8px 10px', marginBottom: 6, fontSize: 12,
                      borderRadius: 6, border: '1px solid #E5E9EE', background: 'transparent',
                    }}>
                    <span className="flex items-center gap-2" style={{ color: '#0F0F10' }}>
                      <ShoppingBag size={13} style={{ color: '#FF8730' }} /> Consignor Purchase
                      <span className="font-mono" style={{ color: '#3D7FFF', marginLeft: 4 }}>{linkedPurchase.purchaseNumber}</span>
                    </span>
                    <span className="font-mono" style={{ color: (linkedPurchase.paidAmount || 0) >= linkedPurchase.totalAmount ? '#16A34A' : '#FF8730' }}>
                      <Bhd v={linkedPurchase.totalAmount - (linkedPurchase.paidAmount || 0)}/> BHD owed
                    </span>
                  </button>
                )}
                {linkedLossExpense && (
                  <button onClick={() => navigate('/expenses')}
                    className="cursor-pointer flex items-center justify-between w-full"
                    style={{
                      padding: '8px 10px', fontSize: 12,
                      borderRadius: 6, border: '1px solid rgba(220,38,38,0.20)', background: 'rgba(220,38,38,0.04)',
                    }}>
                    <span className="flex items-center gap-2" style={{ color: '#DC2626' }}>
                      <Receipt size={13} /> Consignor Loss Expense
                      <span className="font-mono" style={{ marginLeft: 4 }}>{linkedLossExpense.expenseNumber}</span>
                    </span>
                    <span className="font-mono" style={{ color: '#DC2626' }}><Bhd v={linkedLossExpense.amount}/> BHD</span>
                  </button>
                )}
              </div>
            )}
          </Card>
        )}

        {/* D3 — die Rückzahlung der Auszahlung, wenn die Ware nach dem Verkauf an den Einlieferer zurückging. */}
        {(consignment.consignorSide?.refunds.length ?? 0) > 0 && (
          <Card style={{ padding: 14, marginBottom: 18 }}>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>Consignor Repayment</span>
            {consignment.consignorSide!.refunds.map(r => (
              <div key={r.returnId} data-consignor-repayment={r.mode} className="flex justify-between items-center"
                style={{ fontSize: 13, padding: '6px 0', borderBottom: '1px solid #F0F2F5' }}>
                <span style={{ color: '#0F0F10' }}>
                  <span className="font-mono" style={{ color: '#3D7FFF', marginRight: 8 }}>{r.returnNumber}</span>
                  {r.mode === 'received'
                    ? <>Received {r.date} · {r.method === 'bank' ? 'Bank Transfer' : r.method === 'benefit' ? 'Benefit' : 'Cash'}</>
                    : r.open <= 0.0005
                      ? <>Repayment settled (offset)</>
                      : r.open < r.amount - 0.0005
                        ? <>Repayment partly settled — <strong style={{ color: '#B45309' }}><Bhd v={r.open}/> BHD still open</strong></>
                        : <>Repayment pending — <strong style={{ color: '#B45309' }}><Bhd v={r.open}/> BHD open</strong></>}
                </span>
                <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={r.amount}/> BHD</span>
              </div>
            ))}
            {consignment.consignorSide!.refundOpen > 0.0005 && (
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
                The open amount is the consignor&apos;s supplier credit — it is offset when his next payout is paid with “Credit”.
                Recording a later cash repayment waits for the accountant&apos;s booking rule.
              </div>
            )}
          </Card>
        )}

        {/* Payout Details (paid_out) */}
        {consignment.status === 'paid_out' && (
          <Card style={{ padding: 14, marginBottom: 18 }}>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>Payout Details</span>
            <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: '#6B7280' }}>Status</span>
              <StatusDot status={consignment.payoutStatus} />
            </div>
            {consignment.payoutMethod && (
              <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: '#6B7280' }}>Method</span>
                <span style={{ color: '#0F0F10' }}>{consignment.payoutMethod === 'bank_transfer' ? 'Bank Transfer' : consignment.payoutMethod === 'cash' ? 'Cash' : consignment.payoutMethod === 'benefit' ? 'Benefit' : 'Card'}</span>
              </div>
            )}
            {consignment.payoutDate && (
              <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: '#6B7280' }}>Date</span>
                <span style={{ color: '#0F0F10' }}>{consignment.payoutDate}</span>
              </div>
            )}
            {consignment.payoutReference && (
              <div className="flex justify-between" style={{ fontSize: 13 }}>
                <span style={{ color: '#6B7280' }}>Reference</span>
                <span className="font-mono" style={{ color: '#4B5563' }}>{consignment.payoutReference}</span>
              </div>
            )}
          </Card>
        )}

        {/* Active: Expected Payout Preview — SSOT-Projektion zum Agreed/Cost-Preis.
            cost_split @ Kost = Breakeven (Marge 0, Payout = Kost). */}
        {consignment.status === 'active' && (() => {
          const proj = computeConsignmentSale(consignment, consignment.agreedPrice);
          const isCostSplit = consignment.commissionType === 'cost_split';
          return (
            <Card style={{ padding: 14, marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>
                {isCostSplit ? 'If Sold at Cost (Breakeven)' : 'If Sold at Agreed Price'}
              </div>
              <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: '#6B7280' }}>
                  {commissionLineLabel(consignment)}
                </span>
                <span className="font-mono" style={{ color: '#0F0F10' }}>
                  <Bhd v={proj.commission}/> BHD
                </span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 13 }}>
                <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                <span className="font-mono" style={{ color: '#7EAA6E' }}>
                  <Bhd v={proj.payout}/> BHD
                </span>
              </div>
            </Card>
          );
        })()}

        {/* Meta Footer Card — Transfer-Detail-Style: alle Detail-Felder + Notes */}
        <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <KvCell label="Consignment Number" value={consignment.consignmentNumber} mono />
            <KvCell label="Status" value={String(consignment.status).toUpperCase()} />
            <KvCell label="Payout Status" value={String(consignment.payoutStatus || 'pending').toUpperCase()} />
            <KvCell label="Agreed Price"
              value={<><Bhd v={consignment.agreedPrice}/> BHD</>} />
            <KvCell label="Minimum Price"
              value={consignment.minimumPrice != null ? <><Bhd v={consignment.minimumPrice}/> BHD</> : '—'} />
            <KvCell label="Commission"
              value={commissionModelLabel(consignment)} />
          </div>
          {consignment.notes && (
            <div style={{ borderTop: '1px solid #F0F2F5', paddingTop: 10 }}>
              <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                Notes
              </div>
              <p style={{ fontSize: 13, color: '#0F0F10', whiteSpace: 'pre-wrap', margin: 0 }}>{consignment.notes}</p>
            </div>
          )}
        </Card>

      </div>

      {/* ── Record Sale (Plan 2026-05) — CONSIGNMENT MULTI-SALE: derselbe Dialog wie Liste und Einlieferer-Seite
            (Käufer mit „+ New Client", Zahlungen, Verkaufstag = Rechnungsdatum, Nummernkreis). ── */}
      <ConsignmentSaleDialog
        open={soldModal}
        consignmentIds={saleIds}
        onClose={() => setSoldModal(false)}
        onSold={reloadAfterReversal}
      />

      {/* ── Pay Out Modal ── */}
      <Modal open={paidModal} onClose={() => setPaidModal(false)} title="Pay Out Consignor" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="rounded font-mono" style={{
            padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
          }}>
            <div className="flex justify-between" style={{ marginBottom: 8 }}>
              <span style={{ color: '#6B7280' }}>Consignor</span>
              <span style={{ color: '#0F0F10' }}>{consignorName}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: '#6B7280' }}>Payout Amount</span>
              <span style={{ color: '#7EAA6E' }}><Bhd v={consignment.payoutAmount || 0}/> BHD</span>
            </div>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>PAYMENT METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {CONSIGNMENT_PAYOUT_METHODS.map(m => (
                <button key={m} onClick={() => setPaidMethod(m)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${paidMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: paidMethod === m ? '#0F0F10' : '#6B7280',
                    background: paidMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'bank_transfer' ? 'Bank Transfer' : m === 'cash' ? 'Cash' : m === 'card' ? 'Card' : 'Benefit'}</button>
              ))}
            </div>
          </div>
          <Input label="REFERENCE" placeholder="Optional reference..."
            value={paidRef}
            onChange={e => setPaidRef(e.target.value)} />
          <WriteError text={w.fehler} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setPaidModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void handleMarkPaid()} disabled={w.busy} data-consignment-payout>Confirm Payout</Button>
          </div>
        </div>
      </Modal>

      {/* ── Return Confirmation Modal ── */}
      <Modal open={returnModal} onClose={() => setReturnModal(false)} title="Return Consignment" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Return <strong style={{ color: '#0F0F10' }}>{productLabel}</strong> to consignor <strong style={{ color: '#0F0F10' }}>{consignorName}</strong>? The product will be set back to in stock.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setReturnModal(false)}>Cancel</Button>
          <Button variant="secondary" onClick={() => void handleReturn()} disabled={w.busy} data-confirm-return>Confirm Return</Button>
        </div>
      </Modal>

      {/* ── Post-Sale Return Modal (Plan §Commission §13) ── */}
      <Modal open={postSaleReturnModal} onClose={() => setPostSaleReturnModal(false)} title="Buyer Returns the Item" width={560}>
        <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 16, lineHeight: 1.5 }}>
          The buyer is returning <strong style={{ color: '#0F0F10' }}>{productLabel}</strong>.
          What should happen with the item?
          {saleGroup.length > 1 && <> Only this item comes back — the other {saleGroup.length - 1} item{saleGroup.length - 1 === 1 ? '' : 's'} of the same invoice stay sold.</>}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          <button onClick={() => setPostSaleDisposition('RETURN_TO_OWNER')} data-consignment-return-disposition="RETURN_TO_OWNER"
            className="cursor-pointer text-left"
            style={{
              padding: '14px 16px', borderRadius: 8,
              border: `1px solid ${postSaleDisposition === 'RETURN_TO_OWNER' ? '#0F0F10' : '#D5D9DE'}`,
              background: postSaleDisposition === 'RETURN_TO_OWNER' ? 'rgba(15,15,16,0.06)' : 'transparent',
            }}>
            <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500 }}>{'↩'} Give back to consignor</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.5 }}>
              Goods leave our system back to <strong>{consignorName}</strong>. Our A/P to him gets cancelled (we owe nothing anymore {'—'} he has his watch back). No inventory effect for us.
              {consignorPaid > 0.0005 && <> He was already paid — his payout comes back (now or later, see below).</>}
            </div>
          </button>
          <button onClick={() => setPostSaleDisposition('KEEP_AS_OWN')} data-consignment-return-disposition="KEEP_AS_OWN"
            className="cursor-pointer text-left"
            style={{
              padding: '14px 16px', borderRadius: 8,
              border: `1px solid ${postSaleDisposition === 'KEEP_AS_OWN' ? '#0F0F10' : '#D5D9DE'}`,
              background: postSaleDisposition === 'KEEP_AS_OWN' ? 'rgba(15,15,16,0.06)' : 'transparent',
            }}>
            <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500 }}>{'📦'} Keep in our inventory</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.5 }}>
              Item becomes our own stock. {consignorPaid > 0.0005
                ? <>The payout to <strong>{consignorName}</strong> (<Bhd v={consignorPaid}/> BHD already paid) stays as it is {'—'} no repayment.</>
                : <>Our A/P to <strong>{consignorName}</strong> (<Bhd v={consignment.payoutAmount || 0}/> BHD) stays open {'—'} we still owe him that.</>}
              {' '}Cost basis for re-sale = <Bhd v={consignment.payoutAmount || 0}/> BHD.
            </div>
          </button>
        </div>
        {postSaleDisposition === 'RETURN_TO_OWNER' && consignorPaid > 0.0005 && (
          <div style={{ marginBottom: 16 }}>
            <ConsignorRefundPicker paid={consignorPaid} name={consignorName} value={postSaleConsignorRefund}
              onChange={setPostSaleConsignorRefund} testId={consignment.id} />
          </div>
        )}
        {(linkedInvoice?.paidAmount || 0) > 0.005 && (
          <div style={{ marginBottom: 16 }}>
            <span className="text-overline">REFUND METHOD (BUYER)</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {POST_SALE_REFUND_METHODS.map(m => (
                <button key={m} onClick={() => setPostSaleRefundMethod(m)} data-consignment-return-refund-method={m}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${postSaleRefundMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: postSaleRefundMethod === m ? '#0F0F10' : '#6B7280',
                    background: postSaleRefundMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{REFUND_LABEL[m]}</button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 6 }}>
              The buyer paid <Bhd v={linkedInvoice?.paidAmount || 0}/> BHD on this invoice — whatever exceeds what he still owes after this return is refunded this way.
            </div>
          </div>
        )}
        <Input label="REASON" placeholder="Optional reason..." value={postSaleReason}
          onChange={e => setPostSaleReason(e.target.value)} data-consignment-return-reason style={{ marginBottom: 16 }} />
        <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12, color: '#4B5563', marginBottom: 16 }}>
          A Credit Note + Sales Return will be created automatically to refund the buyer for this item.
        </div>
        <WriteError text={w.fehler} />
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setPostSaleReturnModal(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void handlePostSaleReturn()} disabled={w.busy} data-consignment-return-after-sale-confirm>Confirm Return</Button>
        </div>
      </Modal>

      {/* ── Cancel Sale Confirmation Modal — D2: die GANZE Rechnung mit ALLEN ihren Kommissionen ── */}
      <Modal open={cancelSaleModal} onClose={() => setCancelSaleModal(false)} title="Cancel Sale" width={600}>
        <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 12, lineHeight: 1.5 }}>
          This will <strong style={{ color: '#0F0F10' }}>fully reverse</strong> the sale
          {saleGroup.length > 1
            ? <> — the <strong>whole invoice with all {saleGroup.length} items</strong>:</>
            : <> of <strong>{productLabel}</strong>:</>}
        </p>
        {saleGroup.length > 1 && (
          <div style={{ marginBottom: 14, border: '1px solid #E5E9EE', borderRadius: 8 }} data-cancel-sale-items>
            {saleGroup.map(c => {
              const p = products.find(x => x.id === c.productId);
              const k = customers.find(x => x.id === c.consignorId);
              return (
                <div key={c.id} className="flex justify-between" style={{ padding: '8px 12px', fontSize: 12, borderBottom: '1px solid #F0F2F5' }}>
                  <span><span className="font-mono" style={{ color: '#6B7280', marginRight: 8 }}>{c.consignmentNumber}</span>{p ? productDisplayName(p) : '—'}</span>
                  <span style={{ color: '#6B7280' }}>{k ? `${k.firstName} ${k.lastName}` : '—'} · <Bhd v={c.salePrice || 0}/> BHD{c.status === 'returned' ? ' · returned' : ''}</span>
                </div>
              );
            })}
          </div>
        )}
        <ul style={{ fontSize: 13, color: '#4B5563', marginBottom: 16, paddingLeft: 18, lineHeight: 1.7 }}>
          {linkedInvoice && (
            <li>Buyer Invoice <span className="font-mono" style={{ color: '#3D7FFF' }}>{formatInvoiceDisplayShort(linkedInvoice)}</span> → <strong>CANCELLED</strong> (AR cleared)</li>
          )}
          {saleGroup.some(c => c.status === 'returned') && (
            <li>The post-sale return{saleGroup.filter(c => c.status === 'returned').length > 1 ? 's' : ''} and credit note{saleGroup.filter(c => c.status === 'returned').length > 1 ? 's' : ''} → <strong>cancelled</strong> (kept as history, not deleted)</li>
          )}
          {/* R6F — die Worte folgen der Buchung: der Rechnungsstorno kehrt Zahlungen im Hauptbuch um. */}
          {linkedInvoice && (linkedInvoice.paidAmount || 0) > 0.005 && (
            <li style={{ color: '#B45309' }}>Buyer's payment of <strong><Bhd v={linkedInvoice.paidAmount}/> BHD</strong> → <strong>reversed in the books</strong> — hand the money back to the buyer</li>
          )}
          <li>Unpaid consignor purchase{saleGroup.length > 1 ? 's' : ''} → <strong>CANCELLED</strong> (AP cleared)</li>
          {linkedLossExpense && (
            <li>Consignor-Loss-Expense <span className="font-mono" style={{ color: '#DC2626' }}>{linkedLossExpense.expenseNumber}</span> → <strong>CANCELLED</strong></li>
          )}
          {(consignment.payoutPaidAmount || 0) > 0.005 && (
            <li style={{ color: '#DC2626' }}>An old payout of <strong><Bhd v={consignment.payoutPaidAmount || 0}/> BHD</strong> without invoice was already paid {'—'} this cannot be undone automatically; please check it with the accountant.</li>
          )}
          <li>Consignment{saleGroup.length > 1 ? 's' : ''} → status back to <strong>active</strong>, sale data cleared; product{saleGroup.length > 1 ? 's' : ''} back to <strong>consignment</strong></li>
        </ul>
        {/* D3 — ging ein Artikel DIESES Verkaufs schon samt Rückzahlung an seinen Einlieferer zurück, ist der Verkauf
            als Ganzes nicht mehr stornierbar (die Ware ist bei ihm, die Rückzahlung steht) — vorher sagen, nicht erst danach. */}
        {saleGroup.filter(c => c.consignorSide?.refunds.some(r => r.currentSale)).map(c => (
          <div key={`settled-${c.id}`} data-cancel-sale-settled={c.id} style={{
            marginBottom: 12, padding: '10px 12px', borderRadius: 6, fontSize: 12, lineHeight: 1.5,
            background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.30)', color: '#B91C1C',
          }}>
            {c.consignmentNumber} already went back to its consignor and the repayment of his payout is recorded
            ({c.consignorSide!.refunds.filter(r => r.currentSale).map(r => r.returnNumber).join(', ')}). This sale can no longer be cancelled as a whole —
            return the other items one by one with <strong>Post-Sale Return</strong>.
          </div>
        ))}
        {/* D3 — ein schon bezahlter Einlieferer: seine Auszahlung wird nicht still als zurückgekommen gebucht. */}
        {saleGroup.filter(c => c.invoiceId && (c.consignorSide?.paid ?? 0) > 0.0005).map(c => {
          const k = customers.find(x => x.id === c.consignorId);
          const name = `${k ? `${k.firstName} ${k.lastName}`.trim() : 'The consignor'}${saleGroup.length > 1 ? ` (${c.consignmentNumber})` : ''}`;
          return (
            <div key={c.id} style={{ marginBottom: 12 }}>
              <ConsignorRefundPicker paid={c.consignorSide?.paid ?? 0} name={name}
                value={cancelRefunds[c.id] ?? { mode: 'received', method: 'cash' }}
                onChange={(v) => setCancelRefunds(prev => ({ ...prev, [c.id]: v }))} testId={c.id} />
            </div>
          );
        })}
        <div style={{
          padding: '10px 12px', borderRadius: 6,
          background: 'rgba(255,135,48,0.06)', border: '1px solid rgba(255,135,48,0.30)',
          fontSize: 12, color: '#7A4A20', marginBottom: 16, lineHeight: 1.5,
        }}>
          Use this when the sale was a mistake (wrong buyer, wrong price, buyer = consignor).
          For a normal post-sale return where the customer brings <strong>one</strong> item back, use <strong>Post-Sale Return</strong> on that item instead {'—'} the other items of the invoice stay sold.
        </div>
        <WriteError text={w.fehler} />
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setCancelSaleModal(false)}>Keep Sale</Button>
          <Button variant="danger" onClick={() => void handleCancelSale()} data-consignment-cancel-sale-confirm
            disabled={w.busy || saleGroup.some(c => c.consignorSide?.refunds.some(r => r.currentSale))}>
            {saleGroup.length > 1 ? `Cancel Sale (${saleGroup.length} items)` : 'Cancel Sale'}
          </Button>
        </div>
      </Modal>

      {/* ── Delete Confirmation Modal ── */}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Consignment" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete consignment <strong style={{ color: '#0F0F10' }}>{consignment.consignmentNumber}</strong> for <strong style={{ color: '#0F0F10' }}>{productLabel}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="consignments"
        entityId={consignment.id}
        title={`History · ${consignment.consignmentNumber}`}
      />

      {/* Edit Modal — ersetzt den alten Inline-Edit-Mode (2026-05-18) */}
      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit Consignment — ${consignment.consignmentNumber}`} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input required label="AGREED PRICE (BHD)" type="number" data-testid="pe-agreed" value={form.agreedPrice}
            onChange={e => setForm({ ...form, agreedPrice: e.target.value })} />
          <Input label="MINIMUM PRICE (BHD)" type="number" placeholder="Optional" value={form.minimumPrice}
            onChange={e => setForm({ ...form, minimumPrice: e.target.value })} />

          {/* Payout-Modell — dieselbe Auswahl wie beim Anlegen, gespeist aus derselben SSOT.
              Gesperrt, sobald aus dem Modell bereits gebuchte Zahlen entstanden sind; dann bleibt
              es sichtbar, aber unveraenderlich, und der Grund steht darunter. Alle uebrigen Felder
              dieses Dialogs bleiben in beiden Faellen benutzbar. */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>PAYOUT MODEL</span>
            <div className="flex flex-wrap gap-2">
              {PAYOUT_MODELS.map(t => (
                <button key={t} type="button"
                  data-payout-model={t}
                  data-payout-selected={form.payoutModel === t ? '1' : '0'}
                  disabled={payoutLock.locked}
                  onClick={() => setForm({ ...form, payoutModel: t })}
                  className="rounded transition-all duration-200"
                  style={{
                    padding: '7px 12px', fontSize: 12,
                    cursor: payoutLock.locked ? 'not-allowed' : 'pointer',
                    opacity: payoutLock.locked && form.payoutModel !== t ? 0.45 : 1,
                    border: `1px solid ${form.payoutModel === t ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.payoutModel === t ? '#0F0F10' : '#6B7280',
                    background: form.payoutModel === t ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {t === 'percent'
                    ? 'Commission % to us'
                    : t === 'consignor_fixed'
                    ? 'Agreed Price + Excess to us'
                    : 'Cost + Split with Consignor'}
                </button>
              ))}
            </div>
            <p data-payout-lock={payoutLock.locked ? '1' : '0'}
              style={{ fontSize: 11, color: payoutLock.locked ? '#B54708' : '#6B7280', marginTop: 8, lineHeight: 1.5 }}>
              {payoutLock.locked
                ? payoutLock.reason
                : form.payoutModel === 'consignor_fixed'
                ? 'Consignor gets the Agreed Price guaranteed — anything we sell above goes to us. Below agreed creates a Consignor-Loss expense.'
                : form.payoutModel === 'cost_split'
                ? "Consignor names his cost (= Agreed Price). Profit above his cost is split with him — by default 50/50."
                : 'We keep a percentage of the actual sale price — consignor gets the rest.'}
            </p>
          </div>

          {payoutFields.rate && (
            <Input required label="COMMISSION RATE (%)" type="number" disabled={payoutLock.locked}
              data-testid="pe-rate" value={form.commissionRate}
              onChange={e => setForm({ ...form, commissionRate: e.target.value })} />
          )}
          {payoutFields.split && (
            <Input required label="SHOP'S SHARE OF PROFIT (%)" type="number" placeholder="50"
              disabled={payoutLock.locked}
              data-testid="pe-split" value={form.excessSplitPct}
              onChange={e => setForm({ ...form, excessSplitPct: e.target.value })} />
          )}

          <Input label="EXPIRY DATE" type="date" value={form.expiryDate}
            onChange={e => setForm({ ...form, expiryDate: e.target.value })} />

          {editAgreed > 0 && (
            <div className="rounded font-mono" style={{
              padding: 12, background: '#F2F7FA',
              border: '1px solid #E5E9EE', fontSize: 12,
            }}>
              <div style={{ marginBottom: 4, color: '#6B7280', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                {form.payoutModel === 'cost_split' ? 'If Sold at Cost (Breakeven)' : 'If Sold at Agreed Price'}
              </div>
              <div className="flex justify-between" style={{ marginTop: 8 }}>
                <span style={{ color: '#6B7280' }}>{commissionLineLabel(editEcon.input)}</span>
                <span style={{ color: '#0F0F10' }}><Bhd v={editEcon.result.commission}/> BHD</span>
              </div>
              <div className="flex justify-between" style={{ marginTop: 6 }}>
                <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                <span data-payout-preview={String(editEcon.result.payout)} style={{ color: '#7EAA6E' }}><Bhd v={editEcon.result.payout}/> BHD</span>
              </div>
            </div>
          )}

          {editError && (
            <p style={{ fontSize: 12, color: '#AA6E6E' }}>{editError}</p>
          )}

          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea
              data-testid="pe-notes"
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }}
            />
          </div>

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={w.busy} data-save-consignment><Save size={14} /> Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function KvCell({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
        {label}
      </div>
      <div className={mono ? 'font-mono' : ''} style={{ fontSize: 13, color: '#0F0F10' }}>{value}</div>
    </div>
  );
}
