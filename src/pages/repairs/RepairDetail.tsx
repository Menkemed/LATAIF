import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Trash2, Save, ClipboardCheck, ExternalLink, Download, MessageCircle, FileText, RotateCcw } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { useRepairStore, computeRepairTotalCost } from '@/stores/repairStore';
import { useGoldStore } from '@/stores/goldStore';
import { SettleGoldModal, type SettleGoldMode } from '@/components/repairs/SettleGoldModal';
import type { RepairWorkType, GoldPayable, CustomerGoldCredit } from '@/core/models/types';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { useProductStore } from '@/stores/productStore';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { formatProductMultiLine } from '@/core/utils/product-format';
import { usePermission } from '@/hooks/usePermission';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import type { Repair, RepairStatus, RepairLine } from '@/core/models/types';
import { REPAIR_FIELDS, type RepairFieldDef } from '@/core/models/repair-fields';
import { MaterialsCard } from '@/components/work-orders/MaterialsCard';
import { AddMaterialModal } from '@/components/work-orders/AddMaterialModal';
import { ImageUpload } from '@/components/ui/ImageUpload';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

// Plan §Repair §6: RECEIVED → IN_PROGRESS → (SENT_TO_WORKSHOP if external) → READY → DELIVERED.
// Flow extended um SENT_TO_WORKSHOP wenn external; sonst direkt ready.
// OWN-scope endet bei 'ready' — kein Pickup, da das Produkt sowieso bei uns bleibt.
function getStatusFlow(repairType: string | undefined, scope?: 'CUSTOMER' | 'OWN'): RepairStatus[] {
  const base: RepairStatus[] = ['received', 'diagnosed', 'in_progress'];
  const ext = repairType === 'external' || repairType === 'hybrid';
  if (scope === 'OWN') {
    return ext ? [...base, 'sent_to_workshop', 'ready'] : [...base, 'ready'];
  }
  if (ext) {
    return [...base, 'sent_to_workshop', 'ready', 'picked_up'];
  }
  return [...base, 'ready', 'picked_up'];
}

const STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  diagnosed: 'Diagnosed',
  in_progress: 'In Progress',
  sent_to_workshop: 'Sent to Workshop',
  ready: 'Ready for Pickup',
  picked_up: 'Picked Up',
  cancelled: 'Cancelled',
  returned: 'Returned',
  RECEIVED: 'Received',
  IN_PROGRESS: 'In Progress',
  SENT_TO_WORKSHOP: 'Sent to Workshop',
  READY: 'Ready for Pickup',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

function getNextStatus(current: RepairStatus, repairType?: string, scope?: 'CUSTOMER' | 'OWN'): RepairStatus | null {
  const flow = getStatusFlow(repairType, scope);
  const idx = flow.indexOf(current);
  if (idx === -1 || idx >= flow.length - 1) return null;
  return flow[idx + 1];
}

export function RepairDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/repairs');
  const {
    repairs, loadRepairs, updateRepair, updateStatus, deleteRepair,
    repairLines, loadRepairLines, getRepairLines, addRepairLine, cancelRepairLine,
  } = useRepairStore();
  // v0.4.3 — KEIN useGoldStore() ohne Selector: das ganze Store-Objekt aendert
  // bei jeder Mutation seine Referenz. Als useEffect-Dependency + goldStore.loadAll()
  // im Effect → Endlos-Loop (RepairDetail fror beim Oeffnen ein). Stabile
  // Selektoren: Actions sind referenz-stabil, State-Arrays aendern nur bei echten
  // Gold-Daten-Aenderungen.
  const goldLoadAll = useGoldStore(s => s.loadAll);
  const goldPayables = useGoldStore(s => s.goldPayables);
  const customerGoldCredits = useGoldStore(s => s.customerGoldCredits);
  const createGoldPayable = useGoldStore(s => s.createGoldPayable);
  const createCustomerGoldCredit = useGoldStore(s => s.createCustomerGoldCredit);
  const creditShopGold = useGoldStore(s => s.creditShopGold);
  const { invoices, loadInvoices } = useInvoiceStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { expenses, loadExpenses } = useExpenseStore();
  const { employees, loadEmployees } = useEmployeeStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Repair>>({});
  // 2026-05-16 — Number-Type-Dialog vor Repair→Invoice Convert.
  const [numberDialogOpen, setNumberDialogOpen] = useState(false);
  // v0.7.6 — Tax-Scheme Picker vor Convert. User soll vor Invoice-Erstellung
  // ZERO ↔ VAT_10 wechseln koennen ohne erst den Repair zu editieren.
  const [taxSchemeDialog, setTaxSchemeDialog] = useState(false);
  const [pendingTaxScheme, setPendingTaxScheme] = useState<'ZERO' | 'VAT_10'>('ZERO');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // v0.4.4 — Lightbox: Klick auf ein Item-Foto zeigt die Vergroesserung im Popup.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const perm = usePermission();

  useEffect(() => {
    loadRepairs(); loadCustomers(); loadProducts(); loadCategories();
    loadInvoices(); loadSuppliers(); loadExpenses(); loadEmployees();
    loadRepairLines();
    goldLoadAll();
  }, [loadRepairs, loadCustomers, loadProducts, loadCategories, loadInvoices,
      loadSuppliers, loadExpenses, loadEmployees, loadRepairLines, goldLoadAll]);

  // v0.7.6 — Explizite In-house-Option als ersten Eintrag, damit User nicht
  // versehentlich "leer" laesst und still als own-work bucht wird. Sentinel-
  // ID '__INHOUSE__' wird beim Save zu undefined (= null in DB) uebersetzt.
  const supplierOptions = useMemo(() => [
    { id: '__INHOUSE__', label: '🏠 In-house / Own work', subtitle: 'No supplier — own labor / own stock', meta: '' },
    ...suppliers.filter(s => s.active).map(s => ({ id: s.id, label: s.name, subtitle: s.phone || '', meta: s.email || '' })),
  ], [suppliers]);

  const repair = useMemo(() => repairs.find(r => r.id === id), [repairs, id]);
  const customer = useMemo(() => repair ? customers.find(c => c.id === repair.customerId) : null, [repair, customers]);
  const product = useMemo(() => repair?.productId ? products.find(p => p.id === repair.productId) : null, [repair, products]);

  // Live payment status from the linked expense — derived from expenseStore so it
  // re-renders automatically when recordExpensePayment() updates the store.
  const workshopExpensePaid = useMemo(() => {
    if (!id || !repair) return false;
    const fee = repair.repairType === 'hybrid'
      ? (repair.estimatedCost || 0)
      : repair.repairType === 'external'
      ? (repair.estimatedCost || repair.internalCost || 0)
      : 0;
    if (fee <= 0) return false;
    const linked = expenses.find(e => e.relatedModule === 'repair' && e.relatedEntityId === id);
    if (!linked) return !!repair.internalPaidFrom;
    return linked.status === 'PAID' || (linked.amount > 0 && linked.paidAmount >= linked.amount - 0.005);
  }, [id, repair, expenses]);

  useEffect(() => {
    if (repair) setForm({ ...repair });
  }, [repair]);

  // Plan repair-multi-supplier — State fuer Add-Line + Add-Gold + Settle-Modal
  const [showAddLineModal, setShowAddLineModal] = useState(false);
  const [newLineForm, setNewLineForm] = useState<{
    supplierId: string; workType: RepairWorkType; description: string; cost: string; dueDate: string;
  }>({ supplierId: '', workType: 'service', description: '', cost: '', dueDate: '' });

  const [showAddGoldModal, setShowAddGoldModal] = useState(false);
  const [newGoldForm, setNewGoldForm] = useState<{
    source: 'workshop' | 'customer'; supplierId: string;
    receivedG: string; usedG: string; karat: string;
    settlementType: 'return_gold' | 'pay_money';
    leftoverDest: 'return' | 'credit' | 'shop_keep';
  }>({
    source: 'workshop', supplierId: '', receivedG: '', usedG: '', karat: '21K',
    settlementType: 'return_gold', leftoverDest: 'return',
  });
  // v0.2.1 — Material-Modal fuer Diamond/Stone/Gold-Piece im Repair
  const [showAddMaterialModal, setShowAddMaterialModal] = useState(false);

  const [settleModal, setSettleModal] = useState<{
    open: boolean; mode: SettleGoldMode; payable?: GoldPayable; credit?: CustomerGoldCredit;
  }>({ open: false, mode: 'settle_supplier_return' });

  // Lines + Gold-Buckets fuer diesen Repair
  const thisRepairLines = useMemo(
    () => id ? getRepairLines(id) : [],
    // repairLines als Dep, damit Re-Renders bei Mutationen greifen
    [id, repairLines, getRepairLines], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const linesTotalCost = useMemo(
    () => thisRepairLines.filter(l => l.status === 'OPEN').reduce((s, l) => s + l.costAmount, 0),
    [thisRepairLines],
  );
  const repairGoldPayables = useMemo(
    () => id ? goldPayables.filter(gp => gp.sourceRepairId === id) : [],
    [id, goldPayables],
  );
  const repairCustomerGoldCredits = useMemo(
    () => id ? customerGoldCredits.filter(gc => gc.sourceRepairId === id) : [],
    [id, customerGoldCredits],
  );

  if (!repair) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Repair not found</p>
      </div>
    );
  }

  function handleAddLine() {
    if (!id || !repair) return;
    const cost = parseFloat(newLineForm.cost) || 0;
    // v0.7.6 — Sentinel '__INHOUSE__' uebersetzen zu null (in-house Arbeit).
    // Echte supplier_id ungleich __INHOUSE__ wird durchgereicht.
    const realSupplierId = newLineForm.supplierId === '__INHOUSE__'
      ? undefined
      : (newLineForm.supplierId || undefined);
    addRepairLine(id, {
      supplierId: realSupplierId,
      workType: newLineForm.workType,
      description: newLineForm.description || undefined,
      costAmount: cost,
      dueDate: newLineForm.dueDate || undefined,
    });
    setShowAddLineModal(false);
    setNewLineForm({ supplierId: '', workType: 'service', description: '', cost: '', dueDate: '' });
  }

  async function handleAddGold() {
    if (!id || !repair) return;
    const received = parseFloat(newGoldForm.receivedG) || 0;
    const used = parseFloat(newGoldForm.usedG) || 0;

    if (newGoldForm.source === 'workshop') {
      // Workshop hat eigenes Gold verwendet → gold_payable
      if (!newGoldForm.supplierId || received <= 0) return;
      createGoldPayable({
        supplierId: newGoldForm.supplierId,
        sourceRepairId: id,
        weightGrams: received,
        karat: newGoldForm.karat,
        settlementType: newGoldForm.settlementType,
      });
    } else {
      // Customer-Gold: leftover behandeln
      if (received <= 0) return;
      const leftover = received - used;
      if (leftover > 0 && newGoldForm.leftoverDest === 'credit') {
        createCustomerGoldCredit({
          customerId: repair.customerId,
          sourceRepairId: id,
          weightGrams: leftover,
          karat: newGoldForm.karat,
          notes: `Customer-Gold leftover from repair ${repair.repairNumber}`,
        });
      } else if (leftover > 0 && newGoldForm.leftoverDest === 'shop_keep') {
        // Plan v0.1.45: Shop-Keep buchen direkt ins precious_metals-Inventar
        // via creditShopGold-Action. gold_movement-Audit-Eintrag entsteht
        // automatisch (source=repair_consumption, target=precious_metals).
        // Repair hat keine eigene branchId — Current-Branch aus Auth (Fallback branch-main).
        const { currentBranchId: getBranch } = await import('@/core/db/helpers');
        let branchId: string;
        try { branchId = getBranch(); } catch { branchId = 'branch-main'; }
        creditShopGold(branchId, newGoldForm.karat, leftover, {
          repairId: id,
          sourceLabel: `Customer-Gold leftover from repair ${repair.repairNumber}`,
        });
      }
      // leftoverDest === 'return' → nichts buchen, nur Doku im Repair-Notes
    }

    setShowAddGoldModal(false);
    setNewGoldForm({
      source: 'workshop', supplierId: '', receivedG: '', usedG: '', karat: '21K',
      settlementType: 'return_gold', leftoverDest: 'return',
    });
  }

  const nextStatus = getNextStatus(repair.status, repair.repairType, repair.repairScope);
  // Hybrid-Margin-Fix: bei Hybrid ziehen wir Internal + Workshop ab, sonst nur internalCost
  // (Workshop ist bei external bereits in internalCost gespiegelt).
  // Plan repair-multi-supplier: bei Multi-Line-Repair zaehlt SUM(OPEN lines) als
  // Workshop-Kost (ueberschreibt Legacy-estimatedCost) — linesTotalCost kommt
  // aus dem Store und re-rendert automatisch bei Line-Mutationen.
  const margin = repair.chargeToCustomer != null
    ? repair.chargeToCustomer - computeRepairTotalCost(repair, linesTotalCost)
    : null;

  // Workshop fee owed to supplier (for display in status panel + OWN-scope).
  // Hybrid: external portion is estimatedCost. External: estimatedCost || internalCost fallback.
  const repairExternalFee = (() => {
    if (repair.repairType === 'hybrid') return repair.estimatedCost || 0;
    if (repair.repairType === 'external') return repair.estimatedCost || repair.internalCost || 0;
    return 0;
  })();

  // Plan §Repair §Pickup ↔ Payment (User-Spec): zwei orthogonale Status.
  // Payment wird aus Invoice abgeleitet wenn verlinkt, sonst aus customerPaymentStatus.
  // Pickup ist unabhängig — kein Payment-Gate mehr.
  const linkedInvoice = repair.invoiceId ? invoices.find(i => i.id === repair.invoiceId) : null;
  const charge = repair.chargeToCustomer || 0;
  const paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'FREE' = (() => {
    if (charge <= 0.005) return 'FREE';
    if (linkedInvoice) {
      const paid = linkedInvoice.paidAmount || 0;
      const gross = linkedInvoice.grossAmount || 0;
      if (gross > 0 && paid >= gross - 0.005) return 'PAID';
      if (paid > 0.005) return 'PARTIALLY_PAID';
      return 'UNPAID';
    }
    if (repair.customerPaymentStatus === 'PAID') return 'PAID';
    if (repair.customerPaymentStatus === 'PARTIALLY_PAID') return 'PARTIALLY_PAID';
    return 'UNPAID';
  })();
  const pickupStatus: 'NOT_PICKED_UP' | 'PICKED_UP' = repair.status === 'picked_up' ? 'PICKED_UP' : 'NOT_PICKED_UP';

  // Plan §Repair §Service-Invoice: Service-Item statt Lager-Produkt.
  // Lazy-seeded "Repair Service"-Produkt pro Branch (idempotent). VAT folgt
  // repair.taxScheme (vom New-Repair-Modal gewählt: 0% oder 10%).
  async function handleCreateRepairInvoice() {
    if (!repair || !id || !customer) return;
    if (!repair.chargeToCustomer || repair.chargeToCustomer <= 0) {
      alert('Repair has no charge — no invoice needed. Set Charge to Client first.');
      return;
    }
    if (repair.invoiceId) {
      const existing = invoices.find(i => i.id === repair.invoiceId);
      if (existing) {
        navigate(`/invoices/${existing.id}`);
        return;
      }
    }
    // v0.7.6 — Erst Tax-Scheme-Dialog. Default = aktuelle Repair-taxScheme.
    setPendingTaxScheme(repair.taxScheme === 'ZERO' ? 'ZERO' : 'VAT_10');
    setTaxSchemeDialog(true);
  }

  // v0.7.6 — User bestaetigt Tax-Scheme → weiter zu Number-Type-Dialog.
  function confirmTaxSchemeAndProceed() {
    setTaxSchemeDialog(false);
    setNumberDialogOpen(true);
  }

  async function executeRepairInvoiceCreate(specialMark: boolean) {
    setNumberDialogOpen(false);
    if (!repair || !id || !customer) return;
    const { getOrCreateRepairServiceProductId } = await import('@/stores/repairStore');
    const { currentBranchId: getBranch } = await import('@/core/db/helpers');
    let branchId: string;
    try { branchId = getBranch(); } catch { branchId = 'branch-main'; }
    const productId = getOrCreateRepairServiceProductId(branchId);

    const grossCharge = repair.chargeToCustomer!;
    // v0.7.6 — User-bestaetigtes Schema (aus taxSchemeDialog) statt repair.taxScheme.
    // Wenn anders als gespeicherten, wird der Repair auch auf das neue Schema
    // persistiert damit nachfolgende Views konsistent sind.
    const scheme = pendingTaxScheme;
    if (scheme !== repair.taxScheme) {
      updateRepair(id, { taxScheme: scheme });
    }
    const rate = scheme === 'VAT_10' ? 10 : 0;
    // chargeToCustomer ist gross-incl-VAT. Bei VAT_10 → Net = gross/1.1.
    const netAmount = scheme === 'VAT_10' ? grossCharge / (1 + rate / 100) : grossCharge;
    const vatAmount = grossCharge - netAmount;

    const invoice = useInvoiceStore.getState().createDirectInvoice(
      repair.customerId,
      [{
        productId,
        unitPrice: netAmount,
        purchasePrice: repair.internalCost || 0,
        taxScheme: scheme,
        vatRate: rate,
        vatAmount,
        lineTotal: grossCharge,
      }],
      `Repair Service · ${repair.repairNumber}${repair.issueDescription ? ' · ' + repair.issueDescription : ''}`,
      undefined,
      'repair',
      undefined,
      specialMark,
    );
    if (invoice) {
      updateRepair(id, { invoiceId: invoice.id });
      navigate(`/invoices/${invoice.id}`);
    }
  }

  function handleSave() {
    if (!id) return;
    // v0.7.4 — Workshop optional bei Edit (consistent mit Create). Discovery-Pattern:
    // Workshop kommt evtl. erst spaeter via "Add Work Line". Status-Transition
    // (handleStatusAdvance) warnt freundlich wenn man fortfaehrt ohne Workshop.
    // Internal cost mirrors actual (or estimated if actual not yet set) unless explicitly overridden.
    // Bei Hybrid ist der Fallback aber nicht erlaubt: dort ist estimatedCost = Workshop Fee
    // (separate Größe), und darf nicht in internalCost gespiegelt werden — sonst doppelt
    // gezählt in der Margin.
    const derivedInternal = form.actualCost ?? form.estimatedCost ?? 0;
    const effectiveInternal = form.repairType === 'hybrid'
      ? (form.internalCost || 0)
      : (form.internalCost && form.internalCost > 0 ? form.internalCost : derivedInternal);
    const totalCost = form.repairType === 'hybrid'
      ? effectiveInternal + (form.estimatedCost || 0)
      : effectiveInternal;
    const computedMargin = form.chargeToCustomer != null
      ? form.chargeToCustomer - totalCost
      : undefined;
    updateRepair(id, {
      diagnosis: form.diagnosis,
      estimatedCost: form.estimatedCost,
      actualCost: form.actualCost,
      internalCost: effectiveInternal,
      chargeToCustomer: form.chargeToCustomer,
      customerPaidFrom: form.customerPaidFrom ?? null,
      internalPaidFrom: form.internalPaidFrom ?? null,
      margin: computedMargin,
      repairType: form.repairType,
      externalVendor: form.externalVendor,
      workshopSupplierId: form.workshopSupplierId,
      estimatedReady: form.estimatedReady,
      notes: form.notes,
      // Plan §Repair §Item-Details: kategoriebasierte Item-Attribute beim Save mitnehmen
      itemCategoryId: form.itemCategoryId,
      itemAttributes: form.itemAttributes,
      itemBrand: form.itemBrand,
      itemModel: form.itemModel,
      itemReference: form.itemReference,
      itemSerial: form.itemSerial,
      itemDescription: form.itemDescription,
      issueDescription: form.issueDescription,
      taxScheme: form.taxScheme,
      images: form.images,
    });
    setEditing(false);
  }

  function handleStatusAdvance() {
    if (!id || !nextStatus || !repair) return;
    // v0.7.4 — Warnung wenn External/Hybrid auf 'sent_to_workshop' oder 'ready'
    // flippt ohne Workshop UND ohne Work-Lines. Workshop kann ueber Hauptfeld
    // ODER ueber Lines kommen — nur wenn beides leer ist, fehlt der Supplier-
    // Bezug fuer die A/P-Buchung.
    const isExternalOrHybrid = repair.repairType === 'external' || repair.repairType === 'hybrid';
    const needsWorkshopCheck = isExternalOrHybrid && (nextStatus === 'sent_to_workshop' || nextStatus === 'ready');
    const hasNoWorkshop = !repair.workshopSupplierId && thisRepairLines.filter(l => l.status === 'OPEN').length === 0;
    if (needsWorkshopCheck && hasNoWorkshop) {
      const statusLabel = nextStatus === 'sent_to_workshop' ? '"Sent to Workshop"' : '"Ready"';
      const confirmed = window.confirm(
        `You're about to move this repair to ${statusLabel}, but no workshop is set yet.\n\n` +
        `If you continue now, no A/P will be booked against a supplier — you'll need to add it manually later via "+ Add Work Line".\n\n` +
        `Continue anyway?`
      );
      if (!confirmed) return;
    }
    try {
      updateStatus(id, nextStatus);
    } catch (err) {
      // Plan §Repair §Picked-Up-Gate: charge > 0 → Invoice + Payment vorher Pflicht.
      // updateStatus throwt mit verständlicher Fehlermeldung; an User durchreichen.
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDelete() {
    if (!id) return;
    deleteRepair(id);
    navigate('/repairs');
  }

  function handleDownloadVoucher() {
    if (!repair) return;
    // Plan §Print — Item-Beschreibung mit allen Specs (vom verknüpften Produkt falls vorhanden).
    const linkedProduct = repair.productId ? products.find(p => p.id === repair.productId) : undefined;
    const itemDesc = linkedProduct
      ? formatProductMultiLine(linkedProduct, categories)
      : `${repair.itemBrand || ''} ${repair.itemModel || ''}`.trim() || 'Item';
    downloadPdf({
      title: `Repair Voucher ${repair.repairNumber}`,
      number: repair.repairNumber,
      date: repair.receivedAt?.split('T')[0] || '',
      subtitle: `Status: ${repair.status.replace('_', ' ')}`,
      customer: customer ? { name: `${customer.firstName} ${customer.lastName}`, phone: customer.phone } : undefined,
      type: 'voucher',
      sections: [
        { title: 'Voucher Code', lines: [{ label: 'Present this code at pickup', value: repair.voucherCode, bold: true }] },
        { title: 'Item', lines: [
          { label: itemDesc, value: '' },
          ...(repair.itemReference && !linkedProduct ? [{ label: 'Reference', value: repair.itemReference }] : []),
          ...(repair.itemSerial && !linkedProduct ? [{ label: 'Serial', value: repair.itemSerial }] : []),
          { label: 'Issue', value: repair.issueDescription },
        ]},
        ...(repair.estimatedReady ? [{ title: 'Schedule', lines: [
          { label: 'Estimated Ready', value: repair.estimatedReady.split('T')[0] },
        ]}] : []),
        ...(repair.chargeToCustomer != null ? [{ title: 'Amount', lines: [
          { label: 'Charge to Customer', value: `${fmt(repair.chargeToCustomer)} BHD`, bold: true },
        ]}] : []),
      ],
      footer: 'Please keep this voucher for pickup. Contact us for status updates.',
    });
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
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...repair }); }}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={handleSave}
                >
                  <Save size={14} /> Save
                </Button>
              </>
            ) : (
              <>
                {nextStatus && perm.canManageRepairs && (
                  <Button variant="primary" onClick={handleStatusAdvance}>
                    <ClipboardCheck size={14} /> Mark as {STATUS_LABELS[nextStatus]}
                  </Button>
                )}
                {/* User-Spec §Repair Return: Ware ohne Reparatur zurück. Sichtbar in
                    allen nicht-terminalen Status (received bis ready). Bei OWN-scope
                    nicht relevant — eigenes Inventar wird nicht "zurückgegeben". */}
                {perm.canManageRepairs && repair.repairScope !== 'OWN' && repair.status !== 'picked_up' && repair.status !== 'returned'
                  && repair.status !== 'cancelled' && repair.status !== 'CANCELLED' && repair.status !== 'DELIVERED' && (
                  <Button variant="secondary" onClick={() => {
                    if (!id) return;
                    if (!window.confirm(`Mark repair ${repair.repairNumber} as returned to customer (no repair performed)?`)) return;
                    try { updateStatus(id, 'returned'); }
                    catch (err) { alert(err instanceof Error ? err.message : String(err)); }
                  }}>
                    <RotateCcw size={14} /> Mark as Returned
                  </Button>
                )}
                {repair.status === 'ready' && customer && (
                  <Button variant="secondary" onClick={() => setShowMessage(true)}>
                    <MessageCircle size={14} /> AI Notify
                  </Button>
                )}
                {repair.repairScope !== 'OWN' && customer && !repair.invoiceId && repair.chargeToCustomer != null && repair.chargeToCustomer > 0 && perm.canCreateInvoices && (
                  <Button variant="primary" onClick={handleCreateRepairInvoice}>
                    <FileText size={14} /> Create Invoice
                  </Button>
                )}
                {repair.invoiceId && (
                  <Button variant="ghost" onClick={() => navigate(`/invoices/${repair.invoiceId}`)}>
                    <ExternalLink size={14} /> View Invoice
                  </Button>
                )}
                <Button variant="secondary" onClick={handleDownloadVoucher}><Download size={14} /> Voucher</Button>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                {perm.canManageRepairs && <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>}
              </>
            )}
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>

          {/* Voucher & Status */}
          <div>
            {/* Voucher Code - prominent display */}
            <div className="rounded-xl flex flex-col items-center justify-center"
              style={{ height: 220, background: '#F2F7FA', border: '1px solid #E5E9EE', marginBottom: 24 }}>
              <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Pickup Voucher Code</span>
              <span className="font-mono" style={{ fontSize: 48, color: '#0F0F10', letterSpacing: '0.15em', fontWeight: 600 }}>
                {repair.voucherCode}
              </span>
              <span style={{ fontSize: 12, color: '#6B7280', marginTop: 12 }}>Customer presents this code for pickup</span>
            </div>

            {/* Status Timeline */}
            <div style={{ padding: '16px 20px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>STATUS FLOW</span>
              <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                {(() => {
                  const flow = getStatusFlow(repair.repairType, repair.repairScope);
                  const currentIdx = flow.indexOf(repair.status);
                  return flow.map((s, i) => {
                    const isActive = i <= currentIdx;
                    const isCurrent = s === repair.status;
                    return (
                      <div key={s} className="flex items-center gap-2">
                        <span style={{
                          fontSize: 12,
                          padding: '4px 10px',
                          borderRadius: 4,
                          background: isCurrent ? 'rgba(15,15,16,0.1)' : 'transparent',
                          color: isCurrent ? '#0F0F10' : isActive ? '#0F0F10' : '#6B7280',
                          border: isCurrent ? '1px solid rgba(15,15,16,0.15)' : '1px solid transparent',
                          fontWeight: isCurrent ? 500 : 400,
                        }}>
                          {STATUS_LABELS[s] || s}
                        </span>
                        {i < flow.length - 1 && (
                          <span style={{ color: isActive ? '#6B7280' : '#D5D9DE', fontSize: 10 }}>&#8250;</span>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>

              {/* Payment + Pickup als zwei unabhängige Status (User-Spec) — sichtbar
                  ab Ready. Bei OWN-scope: kein Pickup (Produkt bleibt intern), stattdessen
                  Workshop-Payable-Status wenn externe Workshop-Kosten anfallen. */}
              {(repair.status === 'ready' || repair.status === 'picked_up') && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #E5E9EE', display: 'grid', gridTemplateColumns: repair.repairScope === 'OWN' ? '1fr' : '1fr 1fr', gap: 12 }}>
                  {repair.repairScope === 'OWN' ? (
                    // OWN-scope: kein Kunden-Payment, stattdessen Workshop-Payable anzeigen
                    repairExternalFee > 0 && repair.workshopSupplierId ? (
                      <div>
                        <span style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Workshop Payable</span>
                        <span style={{
                          fontSize: 12, padding: '4px 10px', borderRadius: 999, display: 'inline-block',
                          background: workshopExpensePaid ? 'rgba(126,170,110,0.12)' : 'rgba(170,110,110,0.12)',
                          color: workshopExpensePaid ? '#5C8550' : '#8A4848',
                          border: `1px solid ${workshopExpensePaid ? 'rgba(126,170,110,0.4)' : 'rgba(170,110,110,0.4)'}`,
                        }}>
                          {workshopExpensePaid
                            ? `Paid · ${repairExternalFee.toLocaleString('en-US', { maximumFractionDigits: 2 })} BHD`
                            : `Pending · ${repairExternalFee.toLocaleString('en-US', { maximumFractionDigits: 2 })} BHD`}
                        </span>
                      </div>
                    ) : null
                  ) : (
                    <>
                      <div>
                        <span style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Payment</span>
                        <span style={{
                          fontSize: 12, padding: '4px 10px', borderRadius: 999, display: 'inline-block',
                          background: paymentStatus === 'PAID' || paymentStatus === 'FREE' ? 'rgba(126,170,110,0.12)'
                            : paymentStatus === 'PARTIALLY_PAID' ? 'rgba(170,149,110,0.12)'
                            : 'rgba(170,110,110,0.12)',
                          color: paymentStatus === 'PAID' || paymentStatus === 'FREE' ? '#5C8550'
                            : paymentStatus === 'PARTIALLY_PAID' ? '#8A7548'
                            : '#8A4848',
                          border: `1px solid ${paymentStatus === 'PAID' || paymentStatus === 'FREE' ? 'rgba(126,170,110,0.4)'
                            : paymentStatus === 'PARTIALLY_PAID' ? 'rgba(170,149,110,0.4)'
                            : 'rgba(170,110,110,0.4)'}`,
                        }}>
                          {paymentStatus === 'FREE' ? 'Free Repair'
                            : paymentStatus === 'PAID' ? 'Paid'
                            : paymentStatus === 'PARTIALLY_PAID' ? 'Partially Paid'
                            : 'Unpaid'}
                        </span>
                      </div>
                      <div>
                        <span style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Pickup</span>
                        <span style={{
                          fontSize: 12, padding: '4px 10px', borderRadius: 999, display: 'inline-block',
                          background: pickupStatus === 'PICKED_UP' ? 'rgba(126,170,110,0.12)' : 'rgba(107,114,128,0.10)',
                          color: pickupStatus === 'PICKED_UP' ? '#5C8550' : '#6B7280',
                          border: `1px solid ${pickupStatus === 'PICKED_UP' ? 'rgba(126,170,110,0.4)' : 'rgba(107,114,128,0.3)'}`,
                        }}>
                          {pickupStatus === 'PICKED_UP' ? 'Picked Up' : 'Not Picked Up'}
                        </span>
                      </div>
                      {/* Workshop Payable für CUSTOMER-scope external/hybrid */}
                      {repairExternalFee > 0 && (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <span style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Workshop Payable</span>
                          <span style={{
                            fontSize: 12, padding: '4px 10px', borderRadius: 999, display: 'inline-block',
                            background: workshopExpensePaid ? 'rgba(126,170,110,0.12)' : 'rgba(170,110,110,0.12)',
                            color: workshopExpensePaid ? '#5C8550' : '#8A4848',
                            border: `1px solid ${workshopExpensePaid ? 'rgba(126,170,110,0.4)' : 'rgba(170,110,110,0.4)'}`,
                          }}>
                            {workshopExpensePaid
                              ? `Paid · ${repairExternalFee.toLocaleString('en-US', { maximumFractionDigits: 2 })} BHD`
                              : `Pending · ${repairExternalFee.toLocaleString('en-US', { maximumFractionDigits: 2 })} BHD`}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Key Info */}
          <div>
            <span className="text-overline">{repair.repairNumber}</span>
            <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>
              {repair.itemBrand ? `${repair.itemBrand} ${repair.itemModel || ''}`.trim() : 'Repair Service'}
            </h1>
            {repair.itemReference && (
              <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 8 }}>
                Ref: {repair.itemReference}
              </span>
            )}
            <div className="flex items-center gap-4" style={{ marginTop: 12 }}>
              <StatusDot status={repair.status} />
              <span style={{ fontSize: 13, color: '#4B5563' }}>
                {repair.repairType === 'external' ? 'External Repair' : repair.repairType === 'hybrid' ? 'Hybrid Repair' : 'Internal Repair'}
              </span>
            </div>

            {/* Customer (nur bei CUSTOMER-scope) — bei OWN-scope stattdessen Inventory-Hinweis */}
            {repair.repairScope === 'OWN' ? (
              <div style={{ marginTop: 20, borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>OWN INVENTORY ITEM</span>
                <span style={{ fontSize: 15, color: '#0F0F10' }}>
                  {product ? `${product.brand} ${product.name}` : 'Linked product'}
                </span>
                {product && (
                  <button onClick={() => navigate(`/collection/${product.id}`)}
                    className="cursor-pointer transition-colors"
                    style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 12, marginTop: 6, padding: 0 }}>
                    View product →
                  </button>
                )}
              </div>
            ) : (
              <div style={{ marginTop: 20, borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>CUSTOMER</span>
                <span style={{ fontSize: 15, color: '#0F0F10' }}>
                  {customer ? `${customer.firstName} ${customer.lastName}` : repair.customerId}
                </span>
                {customer?.phone && (
                  <span style={{ fontSize: 13, color: '#6B7280', display: 'block', marginTop: 4 }}>{customer.phone}</span>
                )}
              </div>
            )}

            {/* Costs */}
            <div style={{ marginTop: 20, borderTop: '1px solid #E5E9EE', paddingTop: 16 }}>
              {editing ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Input label={form.repairType === 'hybrid' ? 'WORKSHOP FEE (BHD)' : 'ESTIMATED COST (BHD)'} type="number" value={form.estimatedCost ?? ''} onChange={e => setForm({ ...form, estimatedCost: e.target.value ? Number(e.target.value) : undefined })} />
                  <Input label="ACTUAL COST (BHD)" type="number" value={form.actualCost ?? ''} onChange={e => setForm({ ...form, actualCost: e.target.value ? Number(e.target.value) : undefined })} />
                  <Input label="INTERNAL COST (BHD)" type="number" value={form.internalCost ?? 0} onChange={e => setForm({ ...form, internalCost: Number(e.target.value) })} />
                  <Input label="CHARGE TO CUSTOMER (BHD)" type="number" value={form.chargeToCustomer ?? ''} onChange={e => setForm({ ...form, chargeToCustomer: e.target.value ? Number(e.target.value) : undefined })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>INTERNAL PAID FROM</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
                      {([null, 'cash', 'bank', 'benefit'] as const).map(o => {
                        const active = (form.internalPaidFrom ?? null) === o;
                        return (
                          <button key={String(o)} type="button" onClick={() => setForm({ ...form, internalPaidFrom: o })}
                            className="cursor-pointer rounded transition-all"
                            style={{ padding: '7px 14px', fontSize: 12,
                              border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                              color: active ? '#0F0F10' : '#6B7280',
                              background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{o === null ? 'None' : o === 'cash' ? 'Cash' : o === 'bank' ? 'Bank' : 'Benefit'}</button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>CUSTOMER PAID WITH</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
                      {([null, 'cash', 'bank', 'benefit'] as const).map(o => {
                        const active = (form.customerPaidFrom ?? null) === o;
                        return (
                          <button key={String(o)} type="button" onClick={() => setForm({ ...form, customerPaidFrom: o })}
                            className="cursor-pointer rounded transition-all"
                            style={{ padding: '7px 14px', fontSize: 12,
                              border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                              color: active ? '#0F0F10' : '#6B7280',
                              background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{o === null ? 'None' : o === 'cash' ? 'Cash' : o === 'bank' ? 'Bank' : 'Benefit'}</button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {repair.estimatedCost != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">
                        {repair.repairType === 'hybrid' ? 'WORKSHOP FEE / EXTERNAL COST' : 'ESTIMATED COST'}
                      </span>
                      <span className="font-display" style={{ fontSize: 16, color: '#4B5563' }}><Bhd v={repair.estimatedCost}/> BHD</span>
                    </div>
                  )}
                  {repair.actualCost != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">ACTUAL COST</span>
                      <span className="font-display" style={{ fontSize: 16, color: '#4B5563' }}><Bhd v={repair.actualCost}/> BHD</span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">INTERNAL COST</span>
                    <span className="font-display" style={{ fontSize: 16, color: '#4B5563' }}><Bhd v={repair.internalCost}/> BHD</span>
                  </div>
                  {repair.chargeToCustomer != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">CHARGE TO CUSTOMER</span>
                      <span className="font-display" style={{ fontSize: 20, color: '#0F0F10' }}><Bhd v={repair.chargeToCustomer}/> BHD</span>
                    </div>
                  )}
                  {repair.customerPaidFrom && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">CUSTOMER PAID WITH</span>
                      <span style={{ fontSize: 13, color: '#4B5563' }}>{repair.customerPaidFrom === 'cash' ? 'Cash' : 'Bank'}</span>
                    </div>
                  )}
                  {repair.internalPaidFrom && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">INTERNAL PAID FROM</span>
                      <span style={{ fontSize: 13, color: '#4B5563' }}>{repair.internalPaidFrom === 'cash' ? 'Cash' : 'Bank'}</span>
                    </div>
                  )}
                  {margin != null && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">MARGIN / PROFIT</span>
                      <span className="font-mono" style={{ fontSize: 16, color: margin >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                        <Bhd v={margin}/> BHD
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Details Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

          {/* Repair Info */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>REPAIR DETAILS</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Repair Type */}
                  <div>
                    <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Repair Type</span>
                    <div className="flex flex-wrap gap-1">
                      {(['internal', 'external', 'hybrid'] as Repair['repairType'][]).map(t => (
                        <button key={t} onClick={() => setForm({ ...form, repairType: t })}
                          className="cursor-pointer" style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                            background: form.repairType === t ? 'rgba(15,15,16,0.1)' : 'transparent',
                            color: form.repairType === t ? '#0F0F10' : '#6B7280',
                          }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
                      ))}
                    </div>
                  </div>
                  {/* Plan §Repair §Workshop-as-Supplier: Picker statt Free-Text.
                      v0.7.6 — __INHOUSE__ Sentinel uebersetzt zu undefined. */}
                  <SearchSelect
                    label={(form.repairType === 'external' || form.repairType === 'hybrid')
                      ? 'WORKSHOP / GOLDSMITH (SUPPLIER) *'
                      : 'WORKSHOP / GOLDSMITH (SUPPLIER)'}
                    placeholder="Search supplier..."
                    options={supplierOptions}
                    value={form.workshopSupplierId || ''}
                    onChange={sid => setForm({ ...form, workshopSupplierId: (sid && sid !== '__INHOUSE__') ? sid : undefined })}
                  />
                  {(form.repairType === 'external' || form.repairType === 'hybrid') && !form.workshopSupplierId && (
                    <p style={{ fontSize: 11, color: '#6B7280', marginTop: -4, lineHeight: 1.4 }}>
                      💡 Optional — if empty, add workshop + cost later via "+ Add Work Line".
                    </p>
                  )}
                  <Input label="ESTIMATED READY DATE" type="date" value={form.estimatedReady || ''} onChange={e => setForm({ ...form, estimatedReady: e.target.value || undefined })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>DIAGNOSIS</span>
                    <textarea
                      value={form.diagnosis || ''}
                      onChange={e => setForm({ ...form, diagnosis: e.target.value || undefined })}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
                    <textarea
                      value={form.notes || ''}
                      onChange={e => setForm({ ...form, notes: e.target.value || undefined })}
                      className="w-full outline-none transition-colors duration-300"
                      rows={3}
                      style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical', marginTop: 6 }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {renderField('Repair Type', repair.repairType.charAt(0).toUpperCase() + repair.repairType.slice(1))}
                  {/* Plan §Repair §Workshop-as-Supplier: bevorzugt Supplier-Lookup;
                      Fallback auf Legacy-Free-Text falls noch nicht migriert. */}
                  {(() => {
                    const sup = repair.workshopSupplierId
                      ? suppliers.find(s => s.id === repair.workshopSupplierId)
                      : null;
                    if (sup) {
                      return renderField('Workshop / Goldsmith', (
                        <button onClick={() => navigate(`/suppliers/${sup.id}`)}
                          className="cursor-pointer transition-colors"
                          style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 13, padding: 0, textAlign: 'right' }}>
                          {sup.name} →
                        </button>
                      ));
                    }
                    if (repair.externalVendor) return renderField('External Vendor', repair.externalVendor);
                    return null;
                  })()}
                  {renderField('Received', repair.receivedAt ? new Date(repair.receivedAt).toLocaleDateString() : undefined)}
                  {repair.diagnosedAt && renderField('Diagnosed', new Date(repair.diagnosedAt).toLocaleDateString())}
                  {repair.startedAt && renderField('Started', new Date(repair.startedAt).toLocaleDateString())}
                  {repair.completedAt && renderField('Completed', new Date(repair.completedAt).toLocaleDateString())}
                  {repair.pickedUpAt && renderField('Picked Up', new Date(repair.pickedUpAt).toLocaleDateString())}
                  {repair.estimatedReady && renderField('Estimated Ready', new Date(repair.estimatedReady).toLocaleDateString())}
                  {repair.staffId && renderField('Staff',
                    (() => {
                      const e = employees.find(x => x.id === repair.staffId);
                      return e ? (
                        <span style={{ cursor: 'pointer', color: '#3D7FFF', textDecoration: 'underline' }}
                          onClick={() => navigate(`/employees/${e.id}`)}>
                          {e.name}{e.role ? ` · ${e.role}` : ''}
                        </span>
                      ) : '—';
                    })()
                  )}
                  {repair.diagnosis && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Diagnosis</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{repair.diagnosis}</p>
                    </div>
                  )}
                  {repair.notes && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{repair.notes}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>

          {/* Item & Product Info */}
          <Card>
            <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
              <span className="text-overline">ITEM INFORMATION</span>
              {repair.itemCategoryId && (() => {
                const cat = categories.find(c => c.id === repair.itemCategoryId);
                if (!cat) return null;
                return (
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 999,
                    background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                  }}>{cat.name}</span>
                );
              })()}
            </div>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <RepairItemEditor
                  form={form}
                  setForm={setForm}
                  categories={categories.filter(c => !c.id.startsWith('cat-repair-service'))}
                />
              ) : (
                <>
                  {/* Top-Level item-Felder (Legacy + core fields) */}
                  {repair.itemBrand && renderField('Brand', repair.itemBrand)}
                  {repair.itemModel && renderField('Model', repair.itemModel)}
                  {repair.itemReference && renderField('Reference', repair.itemReference)}
                  {repair.itemSerial && renderField('Serial Number', repair.itemSerial)}
                  {/* Kategoriespezifische Attribute aus item_attributes */}
                  {repair.itemCategoryId && repair.itemAttributes && (() => {
                    const fields = REPAIR_FIELDS[repair.itemCategoryId] || [];
                    return fields
                      .filter(f => !f.coreField)
                      .map(f => {
                        const v = repair.itemAttributes?.[f.key];
                        if (v === undefined || v === '') return null;
                        const display = f.unit ? `${v} ${f.unit}` : String(v);
                        return <div key={f.key}>{renderField(f.label, display)}</div>;
                      });
                  })()}
                  {repair.itemDescription && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Item Description</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{repair.itemDescription}</p>
                    </div>
                  )}
                </>
              )}

              {/* Issue Description */}
              <div style={{ marginTop: 16 }}>
                <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Issue Description</span>
                {editing ? (
                  <textarea value={form.issueDescription || ''}
                    onChange={e => setForm({ ...form, issueDescription: e.target.value })}
                    rows={3}
                    style={{ width: '100%', background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical' }} />
                ) : (
                  <p style={{ fontSize: 13, color: '#0F0F10', lineHeight: 1.6 }}>{repair.issueDescription || '\u2014'}</p>
                )}
              </div>

              {/* Item-Fotos \u2014 Zustand bei Annahme */}
              <div style={{ marginTop: 16 }}>
                <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Item Photos</span>
                {editing ? (
                  <ImageUpload
                    images={form.images || []}
                    onChange={imgs => setForm({ ...form, images: imgs })}
                    maxImages={6}
                  />
                ) : (repair.images && repair.images.length > 0) ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {repair.images.map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        alt={`Item photo ${i + 1}`}
                        onClick={() => setLightboxSrc(src)}
                        style={{
                          width: 96, height: 96, objectFit: 'cover', borderRadius: 8,
                          border: '1px solid #E5E9EE', cursor: 'pointer',
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: 13, color: '#9CA3AF' }}>Keine Fotos erfasst.</p>
                )}
              </div>

              {/* v0.4.4 — Foto-Lightbox: Klick aufs Item-Foto zeigt die Vergroesserung. */}
              {lightboxSrc && (
                <div
                  onClick={() => setLightboxSrc(null)}
                  style={{
                    position: 'fixed', inset: 0, zIndex: 9999,
                    background: 'rgba(0,0,0,0.85)', cursor: 'zoom-out',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
                  }}
                >
                  <img
                    src={lightboxSrc}
                    alt="Item photo"
                    style={{
                      maxWidth: '95%', maxHeight: '95%', objectFit: 'contain',
                      borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
                    }}
                  />
                  <button
                    onClick={() => setLightboxSrc(null)}
                    aria-label="Close"
                    style={{
                      position: 'fixed', top: 20, right: 24, width: 40, height: 40, borderRadius: 999,
                      background: 'rgba(255,255,255,0.15)', color: '#FFFFFF', border: 'none',
                      fontSize: 24, lineHeight: 1, cursor: 'pointer',
                    }}
                  >&times;</button>
                </div>
              )}

              {/* Linked Product */}
              {product && (
                <div style={{ marginTop: 20, padding: '12px 14px', background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span style={{ fontSize: 11, color: '#6B7280', display: 'block', marginBottom: 4 }}>Linked Product</span>
                      <span style={{ fontSize: 14, color: '#0F0F10' }}>{product.brand} {product.name}</span>
                      {product.sku && <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', display: 'block', marginTop: 2 }}>{product.sku}</span>}
                    </div>
                    <button
                      onClick={() => navigate(`/collection/${product.id}`)}
                      className="flex items-center gap-1 cursor-pointer transition-colors"
                      style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 12 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#0F0F10')}
                    >
                      <ExternalLink size={12} /> View
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Delete button in edit mode */}
            {editing && repair.status !== 'picked_up' && perm.canDeleteRepairs && (
              <div className="flex gap-2" style={{ marginTop: 20 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Repair
                </Button>
              </div>
            )}
          </Card>

          {/* Plan repair-multi-supplier — Work Lines section (external/hybrid).
              Multi-Supplier-Tracking: jede Zeile ist ein eigener Lieferant +
              Cost + Payment-Status. Beim Status >= IN_PROGRESS wird je Line
              eine eigene Expense gebucht (Supplier-A/P). */}
          {/* v0.7.6 — WORK LINES jetzt auch bei Internal-Repairs sichtbar. Fall:
              Repair startet intern, spaeter kommt externer Bedarf (Diamond-Setter,
              Spare-Part-Supplier). User klickt "+ Add Work Line" → handleAddLine
              schaltet den repairType automatisch auf 'hybrid' (siehe Z.~200).
              Vorher war die Section bei Internal komplett ausgeblendet → User
              musste erst Edit machen + Type umstellen. Unintuitiv. */}
          {(() => {
            // v0.7.6 — Implizite "In-house"-Pseudo-Zeile fuer interne Arbeit.
            // Sichtbar IMMER wenn Repair-Type 'internal' oder 'hybrid' ist — egal
            // wieviele explizite Lines existieren oder ob internalCost > 0.
            // Repraesentiert die Tatsache, dass interne Arbeit Teil des Repairs
            // ist; verschwindet nur bei 'external' (rein extern, keine in-house).
            const explicitLines = thisRepairLines.filter(l => l.status !== 'CANCELLED');
            const inHouseCost = (repair.internalCost
              ?? (repair.repairType === 'internal' ? repair.estimatedCost : 0)
              ?? 0);
            const showInHouseRow = repair.repairType === 'internal' || repair.repairType === 'hybrid';
            const totalLineCount = explicitLines.length + (showInHouseRow ? 1 : 0);
            return (
          <div style={{ marginTop: 20 }}>
            <Card>
              <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
                <span className="text-overline">WORK LINES ({totalLineCount})</span>
                <button onClick={() => setShowAddLineModal(true)}
                  className="cursor-pointer"
                    style={{ padding: '6px 12px', fontSize: 12, borderRadius: 6,
                             border: '1px solid #0F0F10', background: 'transparent', color: '#0F0F10' }}>
                    + Add Work Line
                  </button>
                </div>
                {totalLineCount === 0 ? (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No work lines yet — click "Add Work Line" to register an in-house or workshop position.</p>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1.4fr 0.8fr 1.6fr 0.8fr 0.9fr 1fr', gap: 12, fontSize: 12 }}>
                    <span className="text-overline">L#</span>
                    <span className="text-overline">SUPPLIER</span>
                    <span className="text-overline">WORK TYPE</span>
                    <span className="text-overline">DESCRIPTION</span>
                    <span className="text-overline" style={{ textAlign: 'right' }}>COST</span>
                    <span className="text-overline">PAYMENT</span>
                    <span className="text-overline">ACTIONS</span>
                    {/* v0.7.6 — In-house Pseudo-Zeile zuerst (wenn aktiv). Lebt aus
                        repair.internalCost — kein eigener Datensatz, kein Cancel-
                        Button. User kann den Betrag im Edit-Modus aendern. */}
                    {showInHouseRow && (
                      <div style={{ display: 'contents' }}>
                        <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', padding: '10px 0', borderTop: '1px solid #E5E9EE', whiteSpace: 'nowrap' }}>
                          {repair.repairNumber}-IN
                        </span>
                        <span style={{ fontSize: 12, color: '#0F0F10', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          — own work
                        </span>
                        <span style={{ fontSize: 12, color: '#4B5563', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          In-house
                        </span>
                        <span style={{ fontSize: 12, color: '#6B7280', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          Internal labor / own work
                        </span>
                        <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                          <Bhd v={inHouseCost}/>
                        </span>
                        <span style={{ fontSize: 11, padding: '10px 0', borderTop: '1px solid #E5E9EE', color: '#9CA3AF' }}>
                          — (no A/P)
                        </span>
                        <div style={{ padding: '8px 0', borderTop: '1px solid #E5E9EE', display: 'flex', gap: 6 }}>
                          <span style={{ fontSize: 10, color: '#9CA3AF' }} title="Edit via repair details">edit on header</span>
                        </div>
                      </div>
                    )}
                    {thisRepairLines.filter(l => l.status !== 'CANCELLED').map((l: RepairLine) => {
                      const sup = l.supplierId ? suppliers.find(s => s.id === l.supplierId) : null;
                      return (
                        <div key={l.id} style={{ display: 'contents' }}>
                          {/* v0.1.48 — Volle Sub-Number REP-…-L# fuer Nachverfolgbarkeit
                              (auch im Supplier-/Expense-Kontext eindeutig). v0.4.4 — Spalte
                              auf max-content + nowrap, damit sie nicht vertikal umbricht. */}
                          <span className="font-mono" style={{ fontSize: 12, color: '#6B7280',
                                         padding: '10px 0', borderTop: '1px solid #E5E9EE', whiteSpace: 'nowrap',
                                         textDecoration: l.status === 'CANCELLED' ? 'line-through' : 'none' }}>
                            {repair.repairNumber}-L{l.position}
                          </span>
                          <span style={{ fontSize: 12, color: l.status === 'CANCELLED' ? '#9CA3AF' : '#0F0F10',
                                         padding: '10px 0', borderTop: '1px solid #E5E9EE',
                                         textDecoration: l.status === 'CANCELLED' ? 'line-through' : 'none',
                                         cursor: sup ? 'pointer' : 'default' }}
                            onClick={() => sup && navigate(`/suppliers/${sup.id}`)}>
                            {sup?.name || '—'}
                          </span>
                          <span style={{ fontSize: 12, color: '#4B5563', padding: '10px 0', borderTop: '1px solid #E5E9EE',
                                         textTransform: 'capitalize' }}>
                            {(l.workType || 'other').replace(/_/g, ' ')}
                          </span>
                          <span style={{ fontSize: 12, color: '#6B7280', padding: '10px 0', borderTop: '1px solid #E5E9EE',
                                         overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {l.description || '—'}
                          </span>
                          <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right',
                                                                padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                            <Bhd v={l.costAmount}/>
                          </span>
                          <span style={{ fontSize: 11, padding: '10px 0', borderTop: '1px solid #E5E9EE',
                                         color: l.paymentStatus === 'PAID' ? '#16A34A'
                                              : l.paymentStatus === 'PARTIALLY_PAID' ? '#D97706'
                                              : '#6B7280' }}>
                            {l.expenseId ? (l.paymentStatus || 'UNPAID') : '— (uncommitted)'}
                          </span>
                          <div style={{ padding: '8px 0', borderTop: '1px solid #E5E9EE', display: 'flex', gap: 6 }}>
                            {l.status === 'OPEN' && (
                              <button onClick={() => {
                                if (!confirm('Remove this work line? Any linked gold liability + supplier expense will also be removed.')) return;
                                try { cancelRepairLine(l.id); }
                                catch (err) { alert(err instanceof Error ? err.message : String(err)); }
                              }}
                                style={{ fontSize: 10, padding: '3px 8px', border: '1px solid rgba(220,38,38,0.3)',
                                         borderRadius: 4, background: 'transparent', color: '#DC2626', cursor: 'pointer' }}>
                                Cancel
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {linesTotalCost > 0 && (
                  <div className="flex justify-between" style={{
                    marginTop: 12, paddingTop: 12, borderTop: '1px solid #0F0F10', fontSize: 13,
                  }}>
                    <span style={{ color: '#0F0F10' }}>Total external cost</span>
                    <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={linesTotalCost}/> BHD</span>
                  </div>
                )}
              </Card>
            </div>
            );
          })()}

          {/* v0.2.1 — Materials Used Card (Diamond/Stone/Gold-Piece-Verbrauch) */}
          <div style={{ marginTop: 20 }}>
            <MaterialsCard
              title="MATERIALS USED"
              lines={thisRepairLines
                .filter(l => l.status !== 'CANCELLED' && l.materialKind && l.materialKind !== 'labor')
                .map(l => {
                  const sup = l.supplierId ? suppliers.find(s => s.id === l.supplierId) : null;
                  return {
                    id: l.id,
                    position: l.position,
                    materialKind: l.materialKind,
                    materialDetails: l.materialDetails,
                    description: l.description,
                    supplierId: l.supplierId,
                    supplierName: sup?.name || l.materialDetails?.supplierName,
                    costAmount: l.costAmount,
                    status: l.status,
                  };
                })}
              onAdd={() => setShowAddMaterialModal(true)}
              onRemove={(lineId) => {
                if (!confirm('Remove this material entry? Any linked gold liability + supplier expense will also be removed.')) return;
                try { cancelRepairLine(lineId); }
                catch (err) { alert(err instanceof Error ? err.message : String(err)); }
              }}
              showCustomerPrice={false}
              canEdit={true}
            />
          </div>

          {/* Plan repair-multi-supplier — Gold-Used Block (Workshop + Customer Gold).
              Workshop-Gold legt eine gold_payable an. Customer-Gold-Rest entweder
              zurueck, als Credit, oder vom Shop behalten. */}
          <div style={{ marginTop: 20 }}>
            <Card>
              <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
                <span className="text-overline">
                  GOLD USED ({repairGoldPayables.length + repairCustomerGoldCredits.length})
                </span>
                <button onClick={() => setShowAddGoldModal(true)}
                  className="cursor-pointer"
                  style={{ padding: '6px 12px', fontSize: 12, borderRadius: 6,
                           border: '1px solid #C6A36D', background: 'rgba(198,163,109,0.08)', color: '#8A7548' }}>
                  + Add Gold Usage
                </button>
              </div>
              {repairGoldPayables.length === 0 && repairCustomerGoldCredits.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No gold positions recorded for this repair.</p>
              ) : (
                <>
                  {repairGoldPayables.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                        Workshop Gold (we owe)
                      </div>
                      {repairGoldPayables.map(gp => {
                        const sup = suppliers.find(s => s.id === gp.supplierId);
                        const remaining = Math.max(0, gp.weightGrams - gp.fulfilledGrams);
                        return (
                          <div key={gp.id} className="flex justify-between" style={{
                            padding: '8px 12px', marginBottom: 6,
                            background: '#FAFBFC', border: '1px solid #E5E9EE', borderRadius: 6,
                            fontSize: 12,
                          }}>
                            <div>
                              <span style={{ color: '#0F0F10' }}>{sup?.name || '—'}</span>
                              <span className="font-mono" style={{ color: '#8A7548', marginLeft: 10 }}>
                                {remaining.toFixed(3)}g {gp.karat}
                              </span>
                              <span style={{ color: '#9CA3AF', marginLeft: 8, fontSize: 11 }}>
                                · {gp.settlementType === 'return_gold' ? 'return gold' : 'pay money'} · {gp.status}
                              </span>
                            </div>
                            {gp.status === 'OPEN' && remaining > 0 && (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => setSettleModal({ open: true, mode: 'settle_supplier_return', payable: gp })}
                                  style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #D5D9DE', borderRadius: 4, background: 'transparent', color: '#0F0F10', cursor: 'pointer' }}>
                                  Settle
                                </button>
                                <button onClick={() => setSettleModal({ open: true, mode: 'convert_supplier_money', payable: gp })}
                                  style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #C6A36D', borderRadius: 4, background: 'rgba(198,163,109,0.08)', color: '#8A7548', cursor: 'pointer' }}>
                                  → BHD
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {repairCustomerGoldCredits.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                        Customer Gold (we owe customer)
                      </div>
                      {repairCustomerGoldCredits.map(gc => {
                        const remaining = Math.max(0, gc.weightGrams - gc.fulfilledGrams);
                        return (
                          <div key={gc.id} className="flex justify-between" style={{
                            padding: '8px 12px', marginBottom: 6,
                            background: '#FAFBFC', border: '1px solid #E5E9EE', borderRadius: 6,
                            fontSize: 12,
                          }}>
                            <div>
                              <span style={{ color: '#0F0F10' }}>{customer ? `${customer.firstName} ${customer.lastName}` : '—'}</span>
                              <span className="font-mono" style={{ color: '#8A7548', marginLeft: 10 }}>
                                {remaining.toFixed(3)}g {gc.karat}
                              </span>
                              <span style={{ color: '#9CA3AF', marginLeft: 8, fontSize: 11 }}>· credit · {gc.status}</span>
                            </div>
                            {gc.status === 'OPEN' && remaining > 0 && (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => setSettleModal({ open: true, mode: 'return_customer', credit: gc })}
                                  style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #D5D9DE', borderRadius: 4, background: 'transparent', color: '#0F0F10', cursor: 'pointer' }}>
                                  Return
                                </button>
                                <button onClick={() => setSettleModal({ open: true, mode: 'convert_customer_money', credit: gc })}
                                  style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #C6A36D', borderRadius: 4, background: 'rgba(198,163,109,0.08)', color: '#8A7548', cursor: 'pointer' }}>
                                  → BHD
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </Card>
          </div>
        </div>
      </div>

      {customer && (
        <MessagePreviewModal
          open={showMessage}
          onClose={() => setShowMessage(false)}
          type="repair_ready"
          customerId={customer.id}
          customerName={`${customer.firstName} ${customer.lastName}`}
          customerPhone={customer.phone}
          customerWhatsapp={customer.whatsapp}
          productImage={repair.images?.[0] || product?.images?.[0]}
          productLabel={repair.itemBrand ? `${repair.itemBrand} ${repair.itemModel || ''}`.trim() : (product ? `${product.brand} ${product.name}` : undefined)}
          details={`Voucher code: ${repair.voucherCode}. Repair: ${repair.repairNumber}.${repair.chargeToCustomer ? ` Amount due: ${repair.chargeToCustomer} BHD.` : ''}`}
          linkedEntityType="repair"
          linkedEntityId={repair.id}
        />
      )}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Repair" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete repair <strong style={{ color: '#0F0F10' }}>{repair.repairNumber}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="repairs"
        entityId={repair.id}
        title={`History · ${repair.repairNumber}`}
      />

      <NumberTypeDialog
        open={numberDialogOpen}
        variant="repair"
        onCancel={() => setNumberDialogOpen(false)}
        onConfirm={executeRepairInvoiceCreate}
      />

      {/* v0.7.6 — Tax-Scheme-Dialog vor Convert. User kann ZERO ↔ VAT_10
          umschalten ohne Repair vorher zu editieren. */}
      <Modal open={taxSchemeDialog} onClose={() => setTaxSchemeDialog(false)} title="Choose Tax Scheme" width={460}>
        <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 14 }}>
          Pick the tax scheme for this invoice. <strong>VAT 10%</strong> decomposes the gross
          charge into net + VAT. <strong>Zero</strong> treats the full amount as VAT-free.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {(['ZERO', 'VAT_10'] as const).map(s => (
            <label key={s}
              style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 6,
                       border: `1px solid ${pendingTaxScheme === s ? '#0F0F10' : '#D5D9DE'}`,
                       background: pendingTaxScheme === s ? 'rgba(15,15,16,0.04)' : 'transparent',
                       cursor: 'pointer' }}>
              <input type="radio" checked={pendingTaxScheme === s}
                onChange={() => setPendingTaxScheme(s)} style={{ marginTop: 2 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: '#0F0F10', fontWeight: 500 }}>
                  {s === 'ZERO' ? '0% (No VAT)' : 'VAT 10%'}
                </div>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                  {s === 'ZERO'
                    ? 'No VAT booking — full charge is net.'
                    : 'Charge is gross. Decomposed: net = charge / 1.10, VAT = charge − net.'}
                </div>
              </div>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={() => setTaxSchemeDialog(false)}>Cancel</Button>
          <Button variant="primary" onClick={confirmTaxSchemeAndProceed}>Next: Choose Number Type</Button>
        </div>
      </Modal>

      {/* Plan repair-multi-supplier — Add-Line Modal */}
      <Modal open={showAddLineModal} onClose={() => setShowAddLineModal(false)} title="Add Work Line" width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ padding: '10px 12px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 6, fontSize: 12, color: '#4B5563', lineHeight: 1.5 }}>
            💡 Pick <strong>🏠 In-house</strong> for internal work (no A/P booking) or a
            <strong> supplier</strong> for external work (A/P booked at supplier). The
            repair type (Internal / External / Hybrid) is derived automatically.
          </div>
          <SearchSelect
            label="WORK SOURCE *"
            placeholder="Pick: In-house OR a supplier"
            options={supplierOptions}
            value={newLineForm.supplierId}
            onChange={sid => setNewLineForm({ ...newLineForm, supplierId: sid })}
          />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>WORK TYPE</span>
            <select
              value={newLineForm.workType}
              onChange={e => setNewLineForm({ ...newLineForm, workType: e.target.value as RepairWorkType })}
              style={{ width: '100%', padding: '9px 12px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: '#F2F7FA' }}>
              <option value="service">Service</option>
              <option value="polishing">Polishing</option>
              <option value="spare_part">Spare Part</option>
              <option value="gold_work">Gold Work</option>
              <option value="stone_setting">Stone Setting</option>
              <option value="engraving">Engraving</option>
              <option value="plating">Plating</option>
              <option value="other">Other</option>
            </select>
          </div>
          <Input label="DESCRIPTION" placeholder="e.g. replace mainspring"
            value={newLineForm.description}
            onChange={e => setNewLineForm({ ...newLineForm, description: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Input label="COST (BHD)" type="number" step="0.001"
              value={newLineForm.cost}
              onChange={e => setNewLineForm({ ...newLineForm, cost: e.target.value })} />
            <Input label="DUE DATE (optional)" type="date"
              value={newLineForm.dueDate}
              onChange={e => setNewLineForm({ ...newLineForm, dueDate: e.target.value })} />
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowAddLineModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleAddLine}
              disabled={!newLineForm.supplierId || (!parseFloat(newLineForm.cost) && !newLineForm.description.trim())}>
              Add Line
            </Button>
          </div>
        </div>
      </Modal>

      {/* Plan repair-multi-supplier — Add-Gold Modal */}
      <Modal open={showAddGoldModal} onClose={() => setShowAddGoldModal(false)} title="Add Gold Usage" width={540}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>GOLD SOURCE</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['workshop', 'customer'] as const).map(src => (
                <button key={src} type="button"
                  onClick={() => setNewGoldForm({ ...newGoldForm, source: src })}
                  style={{ padding: '8px 14px', fontSize: 13, borderRadius: 6,
                           border: `1px solid ${newGoldForm.source === src ? '#0F0F10' : '#D5D9DE'}`,
                           background: newGoldForm.source === src ? 'rgba(15,15,16,0.06)' : 'transparent',
                           color: newGoldForm.source === src ? '#0F0F10' : '#6B7280',
                           cursor: 'pointer' }}>
                  {src === 'workshop' ? 'Workshop/Supplier Gold' : 'Customer Gold'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Input label="WEIGHT RECEIVED (g)" type="number" step="0.001"
              value={newGoldForm.receivedG}
              onChange={e => setNewGoldForm({ ...newGoldForm, receivedG: e.target.value })} />
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>KARAT</span>
              <select value={newGoldForm.karat}
                onChange={e => setNewGoldForm({ ...newGoldForm, karat: e.target.value })}
                style={{ width: '100%', padding: '9px 12px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: '#F2F7FA' }}>
                {(['24K','22K','21K','18K','14K','9K','999','925','950'] as const).map(k => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
          </div>

          {newGoldForm.source === 'workshop' ? (
            <>
              <SearchSelect
                label="SUPPLIER / GOLDSMITH"
                placeholder="Pick supplier..."
                options={supplierOptions}
                value={newGoldForm.supplierId}
                onChange={sid => setNewGoldForm({ ...newGoldForm, supplierId: sid })}
              />
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>SETTLEMENT TYPE</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['return_gold', 'pay_money'] as const).map(st => (
                    <button key={st} type="button"
                      onClick={() => setNewGoldForm({ ...newGoldForm, settlementType: st })}
                      style={{ padding: '8px 14px', fontSize: 13, borderRadius: 6,
                               border: `1px solid ${newGoldForm.settlementType === st ? '#0F0F10' : '#D5D9DE'}`,
                               background: newGoldForm.settlementType === st ? 'rgba(15,15,16,0.06)' : 'transparent',
                               color: newGoldForm.settlementType === st ? '#0F0F10' : '#6B7280',
                               cursor: 'pointer' }}>
                      {st === 'return_gold' ? 'Return Gold' : 'Pay Money'}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>
                  Return Gold = wir schulden dem Workshop {newGoldForm.receivedG || '—'}g Gold zurueck (kein BHD-Eintrag bis zur Konvertierung).
                  Pay Money = wir verhandeln spaeter einen BHD-Betrag fuer das Gold.
                </p>
              </div>
            </>
          ) : (
            <>
              <Input label="WEIGHT USED IN REPAIR (g)" type="number" step="0.001"
                value={newGoldForm.usedG}
                onChange={e => setNewGoldForm({ ...newGoldForm, usedG: e.target.value })} />
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>LEFTOVER DESTINATION</span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(['return', 'credit', 'shop_keep'] as const).map(d => (
                    <button key={d} type="button"
                      onClick={() => setNewGoldForm({ ...newGoldForm, leftoverDest: d })}
                      style={{ padding: '8px 14px', fontSize: 13, borderRadius: 6,
                               border: `1px solid ${newGoldForm.leftoverDest === d ? '#0F0F10' : '#D5D9DE'}`,
                               background: newGoldForm.leftoverDest === d ? 'rgba(15,15,16,0.06)' : 'transparent',
                               color: newGoldForm.leftoverDest === d ? '#0F0F10' : '#6B7280',
                               cursor: 'pointer' }}>
                      {d === 'return' ? 'Return to Customer' : d === 'credit' ? 'Customer Credit' : 'Shop Keeps'}
                    </button>
                  ))}
                </div>
                {newGoldForm.leftoverDest === 'shop_keep' && (
                  <p style={{ fontSize: 11, color: '#16A34A', marginTop: 6 }}>
                    Shop behaelt den Rest. Wird ins Shop-Gold-Inventar (precious_metals) gebucht.
                  </p>
                )}
              </div>
            </>
          )}

          <div className="flex justify-end gap-3" style={{ paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowAddGoldModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleAddGold}
              disabled={!parseFloat(newGoldForm.receivedG) ||
                        (newGoldForm.source === 'workshop' && !newGoldForm.supplierId)}>
              Add Gold Usage
            </Button>
          </div>
        </div>
      </Modal>

      <SettleGoldModal
        open={settleModal.open}
        mode={settleModal.mode}
        payable={settleModal.payable}
        credit={settleModal.credit}
        repairId={repair.id}
        onClose={() => setSettleModal({ open: false, mode: 'settle_supplier_return' })}
      />

      {/* v0.2.1 — AddMaterialModal: Diamond/Stone/Gold-Piece -> repair_line */}
      <AddMaterialModal
        open={showAddMaterialModal}
        onClose={() => setShowAddMaterialModal(false)}
        showCustomerPrice={false}
        onSubmit={(data) => {
          // v0.7.6 — Goldsmith-Gold (Kind='gold' + Supplier + Gramm) wird als
          // gold_payable (Gramm-Schuld) gebucht statt als BHD-A/P beim Supplier.
          // Die repair_line traegt dann KEINEN Supplier-Link (sonst Doppel-A/P),
          // behaelt aber costAmount fuer Margin-Calculation. Konsistent zum
          // OrderDetail-Pfad (Z.243). Settlement-Type 'return_gold' default —
          // der User kann spaeter auf 'pay_money' wechseln im Gold-Bucket.
          const goldAsPayable = data.materialKind === 'gold' && !!data.supplierId && (data.weightGrams || 0) > 0;
          const newLine = addRepairLine(repair.id, {
            supplierId: goldAsPayable ? undefined : (data.supplierId || undefined),
            workType: 'service',
            description: data.description,
            costAmount: data.totalCost,
            materialKind: data.materialKind,
            materialDetails: {
              ct: data.caratPerPiece,
              qty: data.quantity,
              description: data.description,
              karat: data.karat,
              weightGrams: data.weightGrams,
              supplierName: data.supplierName,
            },
          });
          if (goldAsPayable && data.supplierId) {
            createGoldPayable({
              supplierId: data.supplierId,
              sourceRepairId: repair.id,
              // v0.7.6 — line-level link, damit cancelRepairLine die Gold-Schuld
              // sauber mitloeschen kann (analog Order-Pattern).
              sourceRepairLineId: newLine.id,
              weightGrams: data.weightGrams!,
              karat: data.karat || '22K',
              // Default: settle by returning gold. User can pivot to pay_money later.
              settlementType: 'return_gold',
            });
          }
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Plan §Repair §Item-Details Edit-Mode: kategorie-basierte Item-Editor-Komponente.
// Wiederverwendet die REPAIR_FIELDS-Config (geteilt mit RepairList).
// ──────────────────────────────────────────────────────────────────────────
interface RepairItemEditorProps {
  form: Partial<Repair>;
  setForm: (v: Partial<Repair>) => void;
  categories: Array<{ id: string; name: string; color: string }>;
}
function RepairItemEditor({ form, setForm, categories }: RepairItemEditorProps) {
  const activeFields: RepairFieldDef[] = form.itemCategoryId ? (REPAIR_FIELDS[form.itemCategoryId] || []) : [];

  function setAttr(key: string, value: string | number | boolean) {
    setForm({ ...form, itemAttributes: { ...(form.itemAttributes || {}), [key]: value } });
  }
  function setCore(field: NonNullable<RepairFieldDef['coreField']>, value: string) {
    setForm({ ...form, [field]: value });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Kategorie-Chips */}
      <div>
        <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>CATEGORY</span>
        <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
          {categories.map(cat => {
            const active = form.itemCategoryId === cat.id;
            return (
              <button key={cat.id}
                onClick={() => setForm({ ...form, itemCategoryId: cat.id, itemAttributes: {} })}
                className="cursor-pointer rounded-lg transition-all duration-200"
                style={{
                  padding: '8px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                  border: `1px solid ${active ? cat.color : '#D5D9DE'}`,
                  color: active ? cat.color : '#6B7280',
                  background: active ? cat.color + '08' : 'transparent',
                }}>
                <span className="rounded-full" style={{ width: 5, height: 5, background: cat.color }} />
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Kategoriespezifische Felder */}
      {activeFields.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {activeFields.map(field => {
            const value = field.coreField
              ? (form[field.coreField] as string | undefined) || ''
              : (form.itemAttributes?.[field.key] as string | number | undefined) ?? '';
            if (field.type === 'select' && field.options) {
              return (
                <div key={field.key}>
                  <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                    {field.label.toUpperCase()}
                    {field.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                  </span>
                  <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                    {field.options.map(opt => {
                      const sel = value === opt;
                      return (
                        <button key={opt}
                          onClick={() => field.coreField ? setCore(field.coreField, opt) : setAttr(field.key, opt)}
                          className="cursor-pointer transition-all duration-200"
                          style={{
                            padding: '4px 10px', fontSize: 11, borderRadius: 999,
                            border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                            color: sel ? '#0F0F10' : '#6B7280',
                            background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}>{opt}</button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (
              <Input key={field.key}
                required={field.required}
                label={field.label.toUpperCase() + (field.unit ? ` (${field.unit})` : '')}
                type={field.type === 'number' ? 'number' : 'text'}
                value={String(value)}
                onChange={e => {
                  const v = field.type === 'number' ? Number(e.target.value) : e.target.value;
                  if (field.coreField) setCore(field.coreField, String(v));
                  else setAttr(field.key, v);
                }}
              />
            );
          })}
        </div>
      )}

      {/* Generic Brand/Model fallback wenn keine Kategorie */}
      {!form.itemCategoryId && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input label="BRAND" value={form.itemBrand || ''} onChange={e => setForm({ ...form, itemBrand: e.target.value })} />
          <Input label="MODEL" value={form.itemModel || ''} onChange={e => setForm({ ...form, itemModel: e.target.value })} />
        </div>
      )}

      <Input label="ITEM DESCRIPTION (OPTIONAL)" value={form.itemDescription || ''}
        onChange={e => setForm({ ...form, itemDescription: e.target.value })} />
    </div>
  );
}
