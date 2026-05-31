import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Printer } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SkuInput } from '@/components/ui/SkuInput';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { DuplicateWarningModal, type DuplicateMatch } from '@/components/ui/DuplicateWarningModal';
import { StaffSelect } from '@/components/employees/StaffSelect';
import { StaffFilterPill } from '@/components/employees/StaffFilterPill';
import { PrintItemsFilterModal } from '@/components/print/PrintItemsFilterModal';
import { runConsignmentPrint } from '@/core/pdf/consignment-print-helpers';
import type { ItemListFilter } from '@/core/pdf/itemListPdf';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { ConsignmentStatus, Product, Category, TaxScheme } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';
import { Bhd } from '@/components/ui/Bhd';
import { computeConsignmentSale, commissionLineLabel, commissionModelLabel } from '@/core/consignment/economics';

// SQLite gibt fehlende REAL-Spalten als JS-`null` zurück, nicht `undefined`.
// fmt darf nicht crashen — sonst killt eine NULL-Spalte den ganzen Render.
function fmt(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function fmtPct(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

type StatusFilter = '' | ConsignmentStatus;

export function ConsignmentList() {
  const navigate = useNavigate();
  const {
    consignments, loadConsignments, createConsignment,
    recordSale, markPaidOut, markReturned,
  } = useConsignmentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories, createProduct, nextAvailableSku, isSkuTaken, findPossibleDuplicates } = useProductStore();
  const { loadEmployees } = useEmployeeStore();
  const [searchParams] = useSearchParams();
  const staffFilter = searchParams.get('staff') || '';

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  // 2026-05-18: Approval-Style 2-Tab-Layout. 'consignors' zeigt Cards pro
  // Customer mit aggregierten KPIs; 'items' bleibt die flache Tabelle wie zuvor.
  const [tab, setTab] = useState<'consignors' | 'items'>('consignors');
  const [showNew, setShowNew] = useState(false);
  const [showPrintAll, setShowPrintAll] = useState(false);
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  // v0.7.10 — Drei Payout-Modelle:
  //  'percent'           — Commission % to us (Shop zieht X% vom Verkaufspreis ab)
  //  'consignor_fixed'   — Agreed Price + Excess to us (Consignor garantiert agreedPrice, Shop kriegt 100% des Excess)
  //  'cost_split'        — Cost + Split with Consignor (Consignor nennt seinen Kost; Profit drueber wird mit Shop geteilt, default 50/50)
  const [commissionType, setCommissionType] = useState<'percent' | 'consignor_fixed' | 'cost_split'>('percent');
  // Nur fuer cost_split: Shop's Anteil am Profit in %. Default 50 = 50/50.
  // 100 wuerde sich wie consignor_fixed verhalten, 0 wuerde Shop nichts geben.
  const [excessSplitPct, setExcessSplitPct] = useState<string>('50');

  // Quick-action modals
  const [soldModal, setSoldModal] = useState<string | null>(null);
  const [soldPrice, setSoldPrice] = useState('');
  const [soldBuyerId, setSoldBuyerId] = useState<string>('');
  const [soldDate, setSoldDate] = useState<string>('');
  const [soldNotes, setSoldNotes] = useState<string>('');
  const [soldAckShortfall, setSoldAckShortfall] = useState(false);
  const [showQuickBuyer, setShowQuickBuyer] = useState(false);
  const [paidModal, setPaidModal] = useState<string | null>(null);
  const [paidMethod, setPaidMethod] = useState('bank_transfer');
  const [paidRef, setPaidRef] = useState('');

  // New consignment form (Consignor + Konditionen — Produktdaten kommen aus productForm).
  const [form, setForm] = useState({
    consignorId: '',
    agreedPrice: '',
    minimumPrice: '',
    commissionRate: '15',
    expiryDate: '',
    notes: '',
    consignorSearch: '',
    staffId: '',
  });

  // Plan §Consignment §New: Das Produkt wird beim Anlegen NEU erfasst (Kundenware), nicht
  // aus dem eigenen Lager gewählt. Layout/Felder identisch zu Collection > New Item, aber
  // ohne Einkaufspreis/Paid-From/Supplier (wir kaufen das Stück nicht — es bleibt Eigentum
  // des Consignors bis zum Verkauf).
  const [selectedCat, setSelectedCat] = useState<Category | null>(null);
  const [productForm, setProductForm] = useState<Partial<Product>>({
    condition: '', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
  });
  const [aiBusy, setAiBusy] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);
  const lastCheckedFp = useRef('');
  const lastDismissedFp = useRef('');

  useEffect(() => {
    loadConsignments();
    loadCustomers();
    loadProducts();
    loadCategories();
    loadEmployees();
  }, [loadConsignments, loadCustomers, loadProducts, loadCategories, loadEmployees]);

  // Live Duplicate Detection für Consignment-Produkt — siehe WatchList.
  const consignAttrs = productForm.attributes || {};
  const consignFp = [
    productForm.brand, productForm.name, productForm.sku,
    consignAttrs.reference_number, consignAttrs.serial_number,
    consignAttrs.weight, consignAttrs.karat, consignAttrs.item_type,
  ].map(v => String(v ?? '').trim().toUpperCase()).join('|');
  useEffect(() => {
    if (!showNew) { lastCheckedFp.current = ''; lastDismissedFp.current = ''; return; }
    if (duplicateMatches.length > 0) return;
    if (!productForm.brand?.trim() && !productForm.name?.trim() && !productForm.sku?.trim()) return;
    if (consignFp === lastCheckedFp.current) return;
    if (consignFp === lastDismissedFp.current) return;
    const t = setTimeout(() => {
      lastCheckedFp.current = consignFp;
      const possible = findPossibleDuplicates(productForm);
      if (possible.length > 0) setDuplicateMatches(possible);
    }, 800);
    return () => clearTimeout(t);
  }, [consignFp, showNew, duplicateMatches.length, productForm, findPossibleDuplicates]);

  // Lookup helpers
  const getCustomer = (id: string) => customers.find(c => c.id === id);
  const getProduct = (id: string) => products.find(p => p.id === id);

  // Filter consignments
  const filtered = useMemo(() => {
    let r = consignments;
    if (statusFilter) r = r.filter(c => c.status === statusFilter);
    if (staffFilter) r = r.filter(c => c.staffId === staffFilter);
    if (search) {
      r = r.filter(c => matchesDeep(c, search, [getCustomer(c.consignorId), getProduct(c.productId)]));
    }
    return r;
  }, [consignments, statusFilter, search, customers, products, staffFilter]);

  // Stats
  const activeCount = consignments.filter(c => c.status === 'active').length;
  const totalAgreed = consignments
    .filter(c => c.status === 'active')
    .reduce((s, c) => s + c.agreedPrice, 0);

  // Plan §Commission §8: offene Auszahlungen an Besitzer.
  const outstandingPayouts = useMemo(() => {
    return consignments
      .filter(c => c.status === 'sold' && c.payoutStatus !== 'paid')
      .reduce((s, c) => s + (c.payoutAmount || 0), 0);
  }, [consignments]);
  const outstandingCount = useMemo(() =>
    consignments.filter(c => c.status === 'sold' && c.payoutStatus !== 'paid').length
  , [consignments]);

  // 2026-05-18: Aggregat pro Consignor (Customer-Id). Zeigt fuer jede Person mit
  // mind. einem Consignment Items-Held / Total Agreed / Total Sold / Outstanding.
  // Status-Filter (Tab-Pills) wirkt hier nicht — die Cards listen *alle* Consignors
  // unabhaengig vom gewaehlten Status-Pill. Search wirkt aber: matched gegen
  // Consignor-Name (FN/LN/Company) + Items des Consignors.
  type ConsignorAgg = {
    customerId: string;
    customer?: { firstName: string; lastName: string; company?: string; phone?: string; email?: string };
    items: number;
    agreed: number;
    sold: number;
    outstanding: number;
    total: number;
  };
  const consignorAggregates = useMemo<ConsignorAgg[]>(() => {
    const byId = new Map<string, ConsignorAgg>();
    for (const c of consignments) {
      const cid = c.consignorId;
      let acc = byId.get(cid);
      if (!acc) {
        const cust = customers.find(cu => cu.id === cid);
        acc = {
          customerId: cid,
          customer: cust ? { firstName: cust.firstName, lastName: cust.lastName, company: cust.company, phone: cust.phone, email: cust.email } : undefined,
          items: 0, agreed: 0, sold: 0, outstanding: 0, total: 0,
        };
        byId.set(cid, acc);
      }
      acc.total++;
      if (c.status === 'active') {
        acc.items++;
        acc.agreed += c.agreedPrice || 0;
      }
      if (c.status === 'sold') {
        acc.sold += (c.salePrice ?? c.agreedPrice) || 0;
        if (c.payoutStatus !== 'paid') {
          acc.outstanding += c.payoutAmount || 0;
        }
      }
    }
    const list = Array.from(byId.values());
    // Sortierung: aktive Items first, dann Total
    list.sort((a, b) => (b.items - a.items) || (b.total - a.total));
    // Search-Filter applied auf Consignor-Cards
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(a => {
      const name = a.customer ? `${a.customer.firstName} ${a.customer.lastName}`.toLowerCase() : '';
      const comp = (a.customer?.company || '').toLowerCase();
      const phone = (a.customer?.phone || '').toLowerCase();
      return name.includes(q) || comp.includes(q) || phone.includes(q);
    });
  }, [consignments, customers, search]);


  // Live calculation (Vorschau bei Verkauf zum Agreed Price)
  const agreedNum = Number(form.agreedPrice) || 0;
  const rateNum = Number(form.commissionRate) || 0;
  const splitPctNum = Number(excessSplitPct) || 0;
  let commission: number; let payout: number;
  if (commissionType === 'consignor_fixed') {
    // Model 2: Consignor gets Agreed Price, we keep amount above.
    // Bei „Sold to Agreed Price"-Vorschau ist die Marge 0 — Excess entsteht erst
    // wenn tatsächlicher Verkaufspreis > agreed.
    payout = agreedNum;
    commission = 0;
  } else if (commissionType === 'cost_split') {
    // v0.7.10 — cost_split bei Sale = Cost ist die Marge 0 (kein Profit).
    // Echte Aufteilung passiert erst bei Sale > Cost im recordSale-Flow.
    payout = agreedNum;
    commission = 0;
  } else {
    // Model 1: Commission % to us
    commission = agreedNum * (rateNum / 100);
    payout = agreedNum - commission;
  }

  function openNew() {
    setForm({
      consignorId: '',
      agreedPrice: '', minimumPrice: '', commissionRate: '15',
      expiryDate: '', notes: '', consignorSearch: '', staffId: '',
    });
    setCommissionType('percent');
    setExcessSplitPct('50');
    const firstCat = categories[0] || null;
    setSelectedCat(firstCat);
    setProductForm({
      categoryId: firstCat?.id || '',
      condition: firstCat?.conditionOptions?.[0] || '',
      taxScheme: 'MARGIN',
      scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
      images: [],
    });
    setShowNew(true);
  }

  function updateAttr(key: string, value: string | number | boolean) {
    setProductForm(p => ({ ...p, attributes: { ...(p.attributes || {}), [key]: value } }));
  }

  function handleCreate() {
    // Strikte Validierung (2026-05-17): alle Pflichtfelder müssen ausgefüllt
    // sein, sonst muss der User später nochmal im Edit ran.
    if (!form.consignorId) {
      alert('Please select a consignor first.');
      return;
    }
    if (!productForm.categoryId) {
      alert('Please select a category first.');
      return;
    }
    const missing: string[] = [];
    // v0.7.16 — Brand/Name nur bei branded-Kategorien Pflicht.
    // v0.7.16 — unbranded: cat-gold-jewelry + cat-accessory.
    const brandedRequired = !(productForm.categoryId === 'cat-gold-jewelry' || productForm.categoryId === 'cat-accessory');
    if (brandedRequired) {
      if (!productForm.brand?.trim()) missing.push('Brand');
      if (!productForm.name?.trim()) missing.push('Name');
    }
    // Condition ist optional (2026-05-17) — kein Required-Check mehr.
    if (selectedCat) {
      for (const attr of selectedCat.attributes) {
        if (!attr.required) continue;
        if (attr.dependsOn) {
          const dep = productForm.attributes?.[attr.dependsOn.key];
          if (!dep || !attr.dependsOn.valueIncludes.includes(String(dep))) continue;
        }
        const v = productForm.attributes?.[attr.key];
        if (attr.type === 'number') {
          if (typeof v !== 'number' || isNaN(v) || v === 0) missing.push(attr.label);
        } else if (attr.type === 'boolean') {
          if (v === undefined || v === null) missing.push(attr.label);
        } else {
          if (!String(v ?? '').trim()) missing.push(attr.label);
        }
      }
    }
    if (!form.agreedPrice || Number(form.agreedPrice) <= 0) missing.push('Agreed Price');
    if (missing.length > 0) {
      alert(`Please fill in the required fields:\n• ${missing.join('\n• ')}`);
      return;
    }
    // SKU-Duplicate hart blocken (Datenintegrität).
    if (productForm.sku && isSkuTaken(productForm.sku)) {
      alert('Diese SKU / Reference ist bereits vergeben. Bitte eine andere Nummer verwenden.');
      return;
    }
    // Score-basierte Duplicate Detection (nicht-blockierend).
    const possible = findPossibleDuplicates(productForm);
    if (possible.length > 0) {
      setDuplicateMatches(possible);
      return;
    }
    doCreate();
  }

  function doCreate() {
    // Snapshot der Form-Daten BEVOR React was reseted — die DB-Saves laufen
    // gleich in einem Defer-Tick, da darf das Form schon weg sein.
    const snapshot = {
      product: { ...productForm },
      consignorId: form.consignorId,
      agreedPrice: form.agreedPrice,
      minimumPrice: form.minimumPrice,
      commissionRate: form.commissionRate,
      expiryDate: form.expiryDate,
      notes: form.notes,
      staffId: form.staffId,
      commissionType,
      // v0.7.10 — nur bei cost_split relevant. Range-Clamp passiert beim Senden
      // in den Store; hier nimm einfach den User-Input.
      excessSplitPct: Number(excessSplitPct) || 50,
    };

    // Modal sofort zu + Form leeren in DIESEM Tick — React commit'tet den
    // leeren-Modal-State, bevor wir die ~3-4 synchronen DB-Saves anstoßen.
    // Sonst rendert React während der DB-Operation noch den vollen Modal-Tree
    // (Photos, Inputs, AI-Identify-Box) und unter Tauri/sql.js wirkt das wie
    // ein Hänger / führt zur weißen Seite.
    setShowNew(false);
    setDuplicateMatches([]);
    setForm({
      consignorId: '', agreedPrice: '', minimumPrice: '',
      commissionRate: '15', expiryDate: '', notes: '', consignorSearch: '', staffId: '',
    });
    setProductForm({
      condition: '', taxScheme: 'MARGIN', scopeOfDelivery: [],
      purchaseCurrency: 'BHD', attributes: {},
    });
    setSelectedCat(null);

    // DB-Schreiben in den nächsten Macrotask schieben — gibt React Zeit, den
    // modal-close-Render zu commiten, BEVOR der Main-Thread für die synchronen
    // SQLite-Saves blockiert wird.
    setTimeout(() => {
      try {
        const newProduct = createProduct({
          ...snapshot.product,
          purchasePrice: 0,
          stockStatus: 'consignment',
          sourceType: 'CONSIGNMENT',
          quantity: 1,
        });
        const rateVal = Number(snapshot.commissionRate) || 0;
        createConsignment({
          consignorId: snapshot.consignorId,
          productId: newProduct.id,
          agreedPrice: snapshot.agreedPrice ? Number(snapshot.agreedPrice) : 0,
          minimumPrice: snapshot.minimumPrice ? Number(snapshot.minimumPrice) : undefined,
          commissionType: snapshot.commissionType,
          // Model 2 (consignor_fixed): kein separates commission_value — agreedPrice IST der Payout.
          // Model 1 (percent): commissionRate = % to us.
          // Model 3 (cost_split): commissionRate ignoriert; agreedPrice = Cost, excessSplitPct = Shop's Profit-Share.
          commissionRate: snapshot.commissionType === 'percent' ? rateVal : 0,
          excessSplitPct: snapshot.commissionType === 'cost_split'
            ? Math.max(0, Math.min(100, snapshot.excessSplitPct))
            : undefined,
          expiryDate: snapshot.expiryDate || undefined,
          notes: snapshot.notes || undefined,
          staffId: snapshot.staffId || undefined,
        });
      } catch (err) {
        console.error('[Consignment] create failed:', err);
        alert(`Failed to create consignment: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 0);
  }

  // Sold-Flow Validierung: nur Model 2 + sale < agreed verlangt Acknowledge.
  // Bei Model 1 ist der Sale-Preis frei wählbar (Margin geht entsprechend mit).
  // Zusätzlich: Buyer != Consignor (sonst wäre es ein Return, kein Sale).
  const soldValidation = useMemo(() => {
    const empty = { needsAck: false, agreed: 0, shortfall: 0, buyerIsConsignor: false };
    if (!soldModal) return empty;
    const con = consignments.find(c => c.id === soldModal);
    if (!con) return empty;
    const isAgreedExcess = con.commissionType === 'consignor_fixed';
    const sp = Number(soldPrice) || 0;
    const agreed = con.agreedPrice || 0;
    const buyerIsConsignor = !!soldBuyerId && soldBuyerId === con.consignorId;
    if (isAgreedExcess && sp > 0 && sp < agreed) {
      return { needsAck: true, agreed, shortfall: agreed - sp, buyerIsConsignor };
    }
    return { ...empty, agreed, buyerIsConsignor };
  }, [soldModal, soldPrice, soldBuyerId, consignments]);

  function handleRecordSale() {
    if (!soldModal || !soldPrice || !soldBuyerId) return;
    if (soldValidation.buyerIsConsignor) {
      alert('Buyer cannot be the same as the consignor. Use "Return" if the consignor is taking the item back.');
      return;
    }
    if (soldValidation.needsAck && !soldAckShortfall) {
      alert('Please confirm the consignor-loss shortfall before saving.');
      return;
    }
    try {
      recordSale(soldModal, {
        salePrice: Number(soldPrice),
        buyerId: soldBuyerId,
        saleDate: soldDate || new Date().toISOString().split('T')[0],
        notes: soldNotes || undefined,
        acknowledgeShortfall: soldAckShortfall,
      });
      // Modal schließen + Form reset
      setSoldModal(null);
      setSoldPrice('');
      setSoldBuyerId('');
      setSoldDate('');
      setSoldNotes('');
      setSoldAckShortfall(false);
    } catch (e) {
      alert(`Sale failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleMarkPaid() {
    if (!paidModal) return;
    markPaidOut(paidModal, paidMethod, paidRef || undefined);
    setPaidModal(null);
    setPaidMethod('bank_transfer');
    setPaidRef('');
  }

  const statusFilters: { value: StatusFilter; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'sold', label: 'Sold' },
    { value: 'paid_out', label: 'Paid Out' },
    { value: 'returned', label: 'Returned' },
  ];

  return (
    <PageLayout
      title="Consignments"
      subtitle={`${activeCount} active \u00b7 ${fmt(totalAgreed)} BHD total agreed value`}
      showSearch onSearch={setSearch} searchPlaceholder="Search by number, consignor, product..."
      actions={
        <div className="flex items-center gap-3">
          {tab === 'items' && <StaffFilterPill />}
          {tab === 'items' && (
            <div className="flex gap-1" style={{ marginRight: 4 }}>
              {statusFilters.map(sf => (
                <button key={sf.value} onClick={() => setStatusFilter(sf.value)}
                  className="cursor-pointer transition-all duration-200"
                  style={{
                    padding: '6px 12px', borderRadius: 999, fontSize: 12,
                    border: `1px solid ${statusFilter === sf.value ? '#0F0F10' : 'transparent'}`,
                    color: statusFilter === sf.value ? '#0F0F10' : '#6B7280',
                    background: statusFilter === sf.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{sf.label}</button>
              ))}
            </div>
          )}
          {tab === 'consignors' && (
            <Button variant="ghost" onClick={() => setShowPrintAll(true)}>
              <Printer size={14} /> Print All
            </Button>
          )}
          <Button variant="primary" onClick={openNew}>New Consignment</Button>
        </div>
      }
    >
      {outstandingCount > 0 && (
        <div style={{
          marginBottom: 20, padding: '14px 18px', borderRadius: 10,
          border: '1px solid rgba(170,110,110,0.25)', background: 'rgba(170,110,110,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
              Outstanding Consignor Payouts
            </div>
            <div style={{ fontSize: 18, fontWeight: 400, color: '#AA6E6E' }}>
              <Bhd v={outstandingPayouts}/> BHD <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 400 }}>· {outstandingCount} consignment{outstandingCount > 1 ? 's' : ''} sold, not yet paid out</span>
            </div>
          </div>
          <button onClick={() => { setTab('items'); setStatusFilter('sold'); }} className="cursor-pointer"
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid #AA6E6E', background: 'transparent', color: '#AA6E6E' }}>
            View sold
          </button>
        </div>
      )}

      {/* Tab Bar — Approval-Style: Consignors-Cards vs flache Items-Liste */}
      <div className="flex gap-1" style={{ marginBottom: 24 }}>
        {(['consignors', 'items'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="cursor-pointer transition-all duration-200"
            style={{
              padding: '8px 20px', fontSize: 13, borderRadius: 6,
              border: 'none', background: tab === t ? '#E5E9EE' : 'transparent',
              color: tab === t ? '#0F0F10' : '#6B7280',
            }}>{t === 'consignors' ? `Consignors (${consignorAggregates.length})` : `Items (${consignments.length})`}</button>
        ))}
      </div>

      {tab === 'consignors' ? (
        consignorAggregates.length === 0 ? (
          <div style={{ padding: '80px 0', textAlign: 'center' }}>
            <FileText size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
            <p style={{ fontSize: 14, color: '#6B7280' }}>
              {search ? 'No consignors match your search.' : 'No consignors yet.'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            {consignorAggregates.map(agg => {
              const fullName = agg.customer
                ? `${agg.customer.firstName} ${agg.customer.lastName}`.trim() || '(unnamed)'
                : '(deleted customer)';
              const isActive = agg.items > 0;
              return (
                <Card key={agg.customerId} hoverable onClick={() => navigate(`/consignors/${agg.customerId}`)}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                    <h3 style={{ fontSize: 16, color: '#0F0F10', fontWeight: 500 }}>{fullName}</h3>
                    <span style={{ fontSize: 12, color: isActive ? '#7EAA6E' : '#6B7280' }}>
                      {isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  {agg.customer?.company && <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>{agg.customer.company}</p>}
                  {agg.customer?.phone && <p style={{ fontSize: 12, color: '#4B5563', marginBottom: 4 }}>{agg.customer.phone}</p>}
                  <div style={{ borderTop: '1px solid #E5E9EE', marginTop: 12, paddingTop: 12 }}>
                    <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: '#6B7280' }}>Items Held</span>
                      <span style={{ color: '#0F0F10' }}>{agg.items}</span>
                    </div>
                    <div className="flex justify-between" style={{ fontSize: 12 }}>
                      <span style={{ color: '#6B7280' }}>Total Consignments</span>
                      <span style={{ color: '#0F0F10' }}>{agg.total}</span>
                    </div>
                  </div>
                  <div style={{ borderTop: '1px solid #E5E9EE', marginTop: 10, paddingTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Agreed Value</div>
                      <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={agg.agreed}/> BHD</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Sold Value</div>
                      <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={agg.sold}/> BHD</div>
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Outstanding Payout</div>
                      <div className="font-mono" style={{ fontSize: 13, color: agg.outstanding > 0 ? '#AA6E6E' : '#6B7280' }}><Bhd v={agg.outstanding}/> BHD</div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <FileText size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {search || statusFilter ? 'No consignments match your filters.' : 'No consignments yet.'}
          </p>
        </div>
      ) : (
        <Card noPadding>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E9EE' }}>
                {['Number', 'Consignor', 'Product', 'Agreed Price', 'Commission', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '14px 18px', textAlign: 'left', fontSize: 11,
                    fontWeight: 500, letterSpacing: '0.06em', color: '#6B7280',
                    textTransform: 'uppercase',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(con => {
                const cust = getCustomer(con.consignorId);
                const prod = getProduct(con.productId);
                const custName = cust ? `${cust.firstName} ${cust.lastName}` : '\u2014';
                const prodLabel = prod ? `${prod.brand} ${prod.name}` : '\u2014';

                return (
                  <tr key={con.id}
                    className="cursor-pointer transition-colors duration-200"
                    style={{ borderBottom: '1px solid #E5E9EE' }}
                    onClick={() => navigate(`/consignments/${con.id}`)}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.015)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '14px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{con.consignmentNumber}</span>
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      {cust ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate(`/consignors/${cust.id}`); }}
                          title="Open consignor profile"
                          className="cursor-pointer"
                          style={{
                            background: 'none', border: 'none', padding: 0,
                            color: '#715DE3', fontSize: 13,
                            textDecoration: 'underline', textDecorationStyle: 'dotted',
                            textUnderlineOffset: 2, textAlign: 'left',
                          }}
                        >
                          {custName}
                        </button>
                      ) : (
                        <span style={{ fontSize: 13, color: '#9CA3AF' }}>{custName}</span>
                      )}
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <div>
                        <span style={{ fontSize: 13, color: '#0F0F10' }}>{prodLabel}</span>
                        {prod?.sku && (
                          <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>{prod.sku}</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={con.agreedPrice}/></span>
                      <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>BHD</span>
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      {/* v0.7.21 — Modell-Label statt nur Rate; cost_split zeigt "Cost + N% split". */}
                      <span style={{ fontSize: 12, color: '#0F0F10' }}>{commissionModelLabel(con)}</span>
                      {con.commissionAmount != null && (
                        <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>
                          <Bhd v={con.commissionAmount}/> BHD
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <StatusDot status={con.status} />
                    </td>
                    <td style={{ padding: '14px 18px' }}>
                      <div className="flex gap-1">
                        {con.status === 'active' && (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSoldModal(con.id);
                                setSoldPrice(String(con.agreedPrice || ''));
                                setSoldBuyerId('');
                                setSoldDate(new Date().toISOString().split('T')[0]);
                                setSoldNotes('');
                                setSoldAckShortfall(false);
                              }}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 6,
                                border: '1px solid #D5D9DE', color: '#7EAA6E',
                                background: 'transparent',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(126,170,110,0.08)'; e.currentTarget.style.borderColor = '#7EAA6E'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D9DE'; }}
                            >Sold</button>
                            <button
                              onClick={(e) => { e.stopPropagation(); markReturned(con.id); }}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 6,
                                border: '1px solid #D5D9DE', color: '#6B7280',
                                background: 'transparent',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = '#6B7280'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D9DE'; }}
                            >Return</button>
                          </>
                        )}
                        {con.status === 'sold' && con.invoiceId && (
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate(`/invoices/${con.invoiceId}`); }}
                            title="Open buyer invoice"
                            className="cursor-pointer flex items-center gap-1"
                            style={{
                              padding: '4px 10px', fontSize: 11, borderRadius: 4,
                              border: '1px solid #715DE3', color: '#FFFFFF',
                              background: '#715DE3', fontWeight: 500,
                            }}>
                            <FileText size={11} /> Invoice
                          </button>
                        )}
                        {con.status === 'sold' && !con.invoiceId && (
                          // Legacy sold consignments (vor Refactor) — alter Pay-Out-Pfad bleibt verfügbar.
                          <button
                            onClick={(e) => { e.stopPropagation(); setPaidModal(con.id); }}
                            className="cursor-pointer transition-all duration-200"
                            style={{
                              padding: '4px 10px', fontSize: 11, borderRadius: 6,
                              border: '1px solid #D5D9DE', color: '#0F0F10',
                              background: 'transparent',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(15,15,16,0.08)'; e.currentTarget.style.borderColor = '#0F0F10'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#D5D9DE'; }}
                          >Pay Out (legacy)</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── New Consignment Modal ── */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Consignment" width={660}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>

          {/* Consignor Selection */}
          <div>
            <SearchSelect
              label="CONSIGNOR"
              placeholder="Search clients..."
              options={customers.map(c => ({ id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone }))}
              value={form.consignorId}
              onChange={id => setForm({ ...form, consignorId: id })}
            />
            <button onClick={() => setShowQuickCustomer(true)}
              className="cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, marginTop: 6, padding: 0 }}
            >+ New Client</button>
          </div>

          {/* Plan §Consignment §New: Item wird hier neu erfasst — wie Collection > New Item.
              Kein Picker auf eigene Inventar-Produkte. */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
              CONSIGNED ITEM
            </span>
            <div style={{
              padding: '8px 12px', borderRadius: 8, background: '#F2F7FA',
              border: '1px solid #E5E9EE', color: '#6B7280', fontSize: 12, lineHeight: 1.5,
              marginBottom: 16,
            }}>
              <strong style={{ color: '#0F0F10' }}>Customer-owned item:</strong> Newly recorded, belongs to the
              consignor until sold. Not own inventory.
            </div>

            {/* Kategorie */}
            <div style={{ marginBottom: 16 }}>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
                CATEGORY <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
              </span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {categories.map(cat => (
                  <button key={cat.id}
                    onClick={() => {
                      setSelectedCat(cat);
                      setProductForm(p => ({ ...p, categoryId: cat.id, condition: cat.conditionOptions?.[0] || '', attributes: {} }));
                    }}
                    className="cursor-pointer rounded-lg transition-all duration-200"
                    style={{
                      padding: '10px 18px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
                      border: `1px solid ${productForm.categoryId === cat.id ? cat.color : '#D5D9DE'}`,
                      color: productForm.categoryId === cat.id ? cat.color : '#6B7280',
                      background: productForm.categoryId === cat.id ? cat.color + '08' : 'transparent',
                    }}>
                    <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Brand + Name — v0.7.16: branded-Pflicht analog NewProductModal */}
            {(() => {
              // v0.7.16 — unbranded: cat-gold-jewelry + cat-accessory.
    const brandedRequired = !(productForm.categoryId === 'cat-gold-jewelry' || productForm.categoryId === 'cat-accessory');
              return (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Input required={brandedRequired}
                    label={brandedRequired ? 'BRAND' : 'BRAND (OPTIONAL)'}
                    placeholder={brandedRequired ? 'e.g. Rolex, Hermes, Cartier' : 'leer = unbranded'}
                    value={productForm.brand || ''}
                    onChange={e => setProductForm(p => ({ ...p, brand: e.target.value }))} />
                  <Input required={brandedRequired}
                    label={brandedRequired ? 'NAME / MODEL' : 'NAME / MODEL (OPTIONAL)'}
                    placeholder={brandedRequired ? 'e.g. Submariner, Birkin 30' : 'leer = Beleg nimmt Beschreibung'}
                    value={productForm.name || ''}
                    onChange={e => setProductForm(p => ({ ...p, name: e.target.value }))} />
                </div>
              );
            })()}
            <div style={{ marginTop: 16 }}>
              <SkuInput value={productForm.sku || ''}
                onChange={v => setProductForm(p => ({ ...p, sku: v }))} />
            </div>

            {/* Dynamische Kategorie-Attribute */}
            {selectedCat && selectedCat.attributes.length > 0 && (
              <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16, marginTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 12 }}>{selectedCat.name.toUpperCase()} DETAILS</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
                  {selectedCat.attributes.map(attr => {
                    if (attr.dependsOn) {
                      const dep = productForm.attributes?.[attr.dependsOn.key];
                      if (!dep || !attr.dependsOn.valueIncludes.includes(String(dep))) return null;
                    }
                    const isWide = attr.type === 'select' && (attr.options?.length || 0) >= 8;
                    if (attr.type === 'select' && attr.options) {
                      return (
                        <div key={attr.key} style={{ gridColumn: isWide ? '1 / -1' : 'auto' }}>
                          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                            {attr.label.toUpperCase()}
                            {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                          </span>
                          <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                            {attr.options.map(opt => (
                              <button key={opt} onClick={() => updateAttr(attr.key, opt)}
                                className="cursor-pointer transition-all duration-200"
                                style={{
                                  padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                  border: `1px solid ${productForm.attributes?.[attr.key] === opt ? '#0F0F10' : '#D5D9DE'}`,
                                  color: productForm.attributes?.[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                  background: productForm.attributes?.[attr.key] === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                                }}>{opt}</button>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    // v0.7.14 — Boolean → Yes/No-Toggle.
                    if (attr.type === 'boolean') {
                      const val = productForm.attributes?.[attr.key];
                      return (
                        <div key={attr.key}>
                          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                            {attr.label.toUpperCase()}
                            {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                          </span>
                          <div className="flex gap-2" style={{ marginTop: 6 }}>
                            {[true, false].map(opt => (
                              <button key={String(opt)} type="button" onClick={() => updateAttr(attr.key, opt)}
                                className="cursor-pointer rounded"
                                style={{
                                  padding: '4px 14px', fontSize: 11, borderRadius: 999,
                                  border: `1px solid ${val === opt ? '#0F0F10' : '#D5D9DE'}`,
                                  color: val === opt ? '#0F0F10' : '#6B7280',
                                  background: val === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                                }}>{opt ? 'Yes' : 'No'}</button>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={attr.key}>
                        <Input
                          required={attr.required}
                          label={attr.label.toUpperCase() + (attr.unit ? ` (${attr.unit})` : '')}
                          type={attr.type === 'number' ? 'number' : 'text'}
                          placeholder={attr.label}
                          value={(productForm.attributes?.[attr.key] as string) || ''}
                          onChange={e => updateAttr(attr.key, attr.type === 'number' ? Number(e.target.value) : e.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Condition */}
            {selectedCat && selectedCat.conditionOptions.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
                  CONDITION
                </span>
                <div className="flex gap-2" style={{ marginTop: 8 }}>
                  {selectedCat.conditionOptions.map(cond => (
                    <button key={cond} onClick={() => setProductForm(p => ({ ...p, condition: cond }))}
                      className="cursor-pointer rounded transition-all duration-200"
                      style={{
                        padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${productForm.condition === cond ? '#0F0F10' : '#D5D9DE'}`,
                        color: productForm.condition === cond ? '#0F0F10' : '#6B7280',
                        background: productForm.condition === cond ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{cond}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Scope / Included */}
            {selectedCat && selectedCat.scopeOptions.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 8 }}>INCLUDED</span>
                <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                  {selectedCat.scopeOptions.map(item => {
                    const sel = (productForm.scopeOfDelivery || []).includes(item);
                    return (
                      <button key={item}
                        onClick={() => setProductForm(p => {
                          const s = p.scopeOfDelivery || [];
                          return { ...p, scopeOfDelivery: sel ? s.filter(x => x !== item) : [...s, item] };
                        })}
                        className="cursor-pointer transition-all duration-200"
                        style={{
                          padding: '5px 12px', fontSize: 11, borderRadius: 999,
                          border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                          color: sel ? '#0F0F10' : '#6B7280',
                          background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{item}</button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* AI Identify */}
            {productForm.categoryId && (
              <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16, marginTop: 16 }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                  <div>
                    <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                    <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                      Auto-fills brand, name, category fields, description — everything editable.
                    </div>
                  </div>
                  <button disabled={aiBusy}
                    className="cursor-pointer transition-colors"
                    style={{
                      background: aiBusy ? '#6B7280' : '#0F0F10', color: '#FFFFFF',
                      border: 'none', borderRadius: 8, fontSize: 12, padding: '8px 14px',
                    }}
                    onClick={async () => {
                      const ai = await import('@/core/ai/ai-service');
                      if (!ai.isAiConfigured()) { alert('Set OpenAI API key in Settings > AI'); return; }
                      const hasImage = (productForm.images || []).length > 0;
                      const hasHints = !!productForm.brand || !!productForm.name || !!productForm.sku;
                      if (!hasImage && !hasHints) {
                        alert('Add a photo OR type a brand/name/reference hint first, then click AI Identify.');
                        return;
                      }
                      setAiBusy(true);
                      try {
                        const result = await ai.identifyProduct({
                          categoryId: productForm.categoryId as AiCategoryId,
                          imageBase64: hasImage ? productForm.images![0] : undefined,
                          hints: hasHints ? { brand: productForm.brand, name: productForm.name, reference: productForm.sku } : undefined,
                        });
                        // Plan §Consignment §AI-Identify: zwei getrennte setStates.
                        // Updater von setProductForm muss PURE bleiben — kein verschachteltes
                        // setForm darin (würde unter React 18 strict mode doppelt feuern und
                        // im schlimmsten Fall die UI hängen lassen).
                        setProductForm(f => {
                          const updated = { ...f };
                          if (result.brand) updated.brand = result.brand;
                          if (result.name) updated.name = result.name;
                          if (result.sku && !f.sku) updated.sku = nextAvailableSku(result.sku);
                          if (result.condition) updated.condition = result.condition;
                          if (result.description) updated.notes = f.notes ? `${f.notes}\n\n${result.description}` : result.description;
                          if (result.taxScheme && !f.taxScheme) updated.taxScheme = result.taxScheme;
                          if (Array.isArray(result.scopeOfDelivery) && result.scopeOfDelivery.length > 0 && (!f.scopeOfDelivery || f.scopeOfDelivery.length === 0)) {
                            updated.scopeOfDelivery = result.scopeOfDelivery;
                          }
                          const attrs = { ...(f.attributes || {}) };
                          for (const [k, v] of Object.entries(result.attributes || {})) {
                            if (v === null || v === undefined || v === '') continue;
                            attrs[k] = v as string | number | boolean | string[];
                          }
                          updated.attributes = attrs;
                          return updated;
                        });
                        // AI-Schätzung schreibt in den Consignment-Agreed-Price-Vorschlag,
                        // da das Produkt selbst keinen Sale Price hat. Außerhalb des Updaters.
                        if (result.estimatedValue && !form.agreedPrice) {
                          setForm(prev => ({ ...prev, agreedPrice: String(result.estimatedValue) }));
                        }
                        // Sofortige Duplicate-Detection direkt nach AI-Erkennung.
                        const candidate: Partial<Product> = {
                          categoryId: productForm.categoryId,
                          brand: result.brand || productForm.brand,
                          name: result.name || productForm.name,
                          sku: productForm.sku || (result.sku ? nextAvailableSku(result.sku) : undefined),
                          attributes: { ...(productForm.attributes || {}), ...(result.attributes || {}) } as Product['attributes'],
                          images: productForm.images,
                        };
                        const possible = findPossibleDuplicates(candidate);
                        if (possible.length > 0) setDuplicateMatches(possible);
                      } catch (e) { alert(String(e)); }
                      finally { setAiBusy(false); }
                    }}
                  >{aiBusy ? 'Researching…' : 'AI Identify'}</button>
                </div>
              </div>
            )}

            {/* Photos */}
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 16, marginTop: 16 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                <span className="text-overline">PHOTOS</span>
                <span style={{ fontSize: 11, color: '#6B7280' }}>Add at least one photo for best AI results</span>
              </div>
              <ImageUpload images={productForm.images || []}
                onChange={imgs => setProductForm(p => ({ ...p, images: imgs }))}
                maxImages={6} />
            </div>

            {/* Tax Scheme + Storage Location */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
              <div>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>TAX SCHEME</span>
                <div className="flex gap-2" style={{ marginTop: 8 }}>
                  {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(scheme => (
                    <button key={scheme} onClick={() => setProductForm(p => ({ ...p, taxScheme: scheme }))}
                      className="cursor-pointer rounded transition-all duration-200"
                      style={{
                        padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${productForm.taxScheme === scheme ? '#0F0F10' : '#D5D9DE'}`,
                        color: productForm.taxScheme === scheme ? '#0F0F10' : '#6B7280',
                        background: productForm.taxScheme === scheme ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{scheme === 'MARGIN' ? 'Margin' : scheme === 'VAT_10' ? 'VAT 10%' : 'Zero'}</button>
                  ))}
                </div>
              </div>
              <Input label="STORAGE LOCATION" placeholder="Safe, Shelf, Display..."
                value={productForm.storageLocation || ''}
                onChange={e => setProductForm(p => ({ ...p, storageLocation: e.target.value }))} />
            </div>
          </div>

          {/* Pricing */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 12 }}>PRICING</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
              <Input label="AGREED PRICE (BHD)" type="number" placeholder={'Optional \u2014 set at sale'}
                value={form.agreedPrice}
                onChange={e => setForm({ ...form, agreedPrice: e.target.value })} />
              <Input label="MINIMUM PRICE (BHD)" type="number" placeholder="Optional"
                value={form.minimumPrice}
                onChange={e => setForm({ ...form, minimumPrice: e.target.value })} />
            </div>
            <div style={{ marginTop: 16 }}>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>PAYOUT MODEL</span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {(['percent', 'consignor_fixed', 'cost_split'] as const).map(t => (
                  <button key={t} onClick={() => setCommissionType(t)}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '7px 12px', fontSize: 12,
                      border: `1px solid ${commissionType === t ? '#0F0F10' : '#D5D9DE'}`,
                      color: commissionType === t ? '#0F0F10' : '#6B7280',
                      background: commissionType === t ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>
                    {t === 'percent'
                      ? 'Commission % to us'
                      : t === 'consignor_fixed'
                      ? 'Agreed Price + Excess to us'
                      : 'Cost + Split with Consignor'}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                {commissionType === 'consignor_fixed'
                  ? 'Consignor gets the Agreed Price guaranteed — anything we sell above goes to us. Below agreed creates a Consignor-Loss expense.'
                  : commissionType === 'cost_split'
                  ? 'Consignor names his cost (= Agreed Price). Profit above his cost is split with him — by default 50/50. He gets his cost guaranteed; below-cost sales create a Consignor-Loss expense.'
                  : 'We keep a percentage of the actual sale price — consignor gets the rest.'}
              </p>
            </div>
            {commissionType === 'percent' && (
              <div style={{ marginTop: 16 }}>
                <Input
                  label="COMMISSION RATE (%)"
                  type="number"
                  placeholder="15"
                  value={form.commissionRate}
                  onChange={e => setForm({ ...form, commissionRate: e.target.value })} />
              </div>
            )}
            {commissionType === 'cost_split' && (
              <div style={{ marginTop: 16 }}>
                <Input
                  label="SHOP'S SHARE OF PROFIT (%)"
                  type="number"
                  placeholder="50"
                  value={excessSplitPct}
                  onChange={e => setExcessSplitPct(e.target.value)} />
                <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6, lineHeight: 1.5 }}>
                  Anything above the consignor's cost is split: shop keeps {splitPctNum}%, consignor gets {Math.max(0, 100 - splitPctNum)}%.
                </p>
              </div>
            )}

            {/* Live Calculation */}
            {agreedNum > 0 && (commissionType === 'consignor_fixed' || commissionType === 'cost_split' || rateNum > 0) && (
              <div className="rounded font-mono" style={{
                marginTop: 16, padding: 16, background: '#F2F7FA',
                border: '1px solid #E5E9EE', fontSize: 13,
              }}>
                <div style={{ marginBottom: 4, color: '#6B7280', fontSize: 11, letterSpacing: '0.04em' }}>
                  {commissionType === 'cost_split' ? 'IF SOLD AT COST (BREAKEVEN)' : 'IF SOLD AT AGREED PRICE'}
                </div>
                <div className="flex justify-between" style={{ marginTop: 10 }}>
                  <span style={{ color: '#6B7280' }}>
                    {commissionType === 'percent'
                      ? `Commission (${fmtPct(rateNum)}%)`
                      : commissionType === 'cost_split'
                      ? `Our share (no profit yet)`
                      : 'Our margin (excess)'}
                  </span>
                  <span style={{ color: '#0F0F10' }}><Bhd v={commission}/> BHD</span>
                </div>
                <div className="flex justify-between" style={{ marginTop: 8 }}>
                  <span style={{ color: '#6B7280' }}>Payout to Consignor</span>
                  <span style={{ color: '#7EAA6E' }}><Bhd v={payout}/> BHD</span>
                </div>
                {commissionType === 'cost_split' && agreedNum > 0 && (() => {
                  // Beispiel: 50% drueber Cost, damit der User sieht wie's bei
                  // realem Profit aussieht. Skaliert mit dem Cost.
                  const sampleSale = agreedNum * 1.5;
                  const sampleProfit = sampleSale - agreedNum;
                  const shopShare = sampleProfit * (splitPctNum / 100);
                  const consignorShare = agreedNum + sampleProfit * ((100 - splitPctNum) / 100);
                  return (
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed #D5D9DE' }}>
                      <div style={{ color: '#6B7280', fontSize: 11, letterSpacing: '0.04em', marginBottom: 6 }}>
                        EXAMPLE: SOLD AT <Bhd v={sampleSale}/> BHD (cost +50%)
                      </div>
                      <div className="flex justify-between" style={{ marginTop: 4 }}>
                        <span style={{ color: '#6B7280' }}>Profit above cost</span>
                        <span style={{ color: '#0F0F10' }}><Bhd v={sampleProfit}/> BHD</span>
                      </div>
                      <div className="flex justify-between" style={{ marginTop: 4 }}>
                        <span style={{ color: '#6B7280' }}>→ Shop ({splitPctNum}%)</span>
                        <span style={{ color: '#0F0F10' }}><Bhd v={shopShare}/> BHD</span>
                      </div>
                      <div className="flex justify-between" style={{ marginTop: 4 }}>
                        <span style={{ color: '#6B7280' }}>→ Consignor</span>
                        <span style={{ color: '#7EAA6E' }}><Bhd v={consignorShare}/> BHD</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Expiry & Notes */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Input label="EXPIRY DATE" type="date"
              value={form.expiryDate}
              onChange={e => setForm({ ...form, expiryDate: e.target.value })} />
            <StaffSelect value={form.staffId} onChange={(id) => setForm({ ...form, staffId: id })}
              helper="Who took the item in (optional)." />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
            <textarea
              placeholder="Any special terms or notes..."
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              className="w-full outline-none transition-colors duration-300"
              style={{
                marginTop: 6, background: 'transparent',
                borderBottom: '1px solid #D5D9DE', border: 'none',
                borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: '#D5D9DE',
                padding: '10px 0', fontSize: 14, color: '#0F0F10',
                resize: 'vertical', minHeight: 60,
              }}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => (e.currentTarget.style.borderBottomColor = '#D5D9DE')}
            />
          </div>

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}
              disabled={!form.consignorId || !productForm.categoryId}
            >Create Consignment</Button>
          </div>
        </div>
      </Modal>

      <QuickCustomerModal
        open={showQuickCustomer}
        onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => { loadCustomers(); setForm(f => ({ ...f, consignorId: id })); }}
      />

      {/* ── Record Sale Modal (Plan 2026-05) ── */}
      <Modal open={!!soldModal} onClose={() => { setSoldModal(null); setSoldAckShortfall(false); }} title="Record Sale" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Buyer-Picker */}
          <div>
            <SearchSelect
              label="BUYER"
              placeholder="Search clients..."
              options={customers.map(c => ({ id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone }))}
              value={soldBuyerId}
              onChange={id => setSoldBuyerId(id)}
            />
            <button onClick={() => setShowQuickBuyer(true)}
              className="cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, marginTop: 6, padding: 0 }}
            >+ New Client</button>
          </div>

          {/* Sale Price */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Input required label="SALE PRICE (BHD)" type="number" placeholder="0"
              value={soldPrice}
              onChange={e => { setSoldPrice(e.target.value); setSoldAckShortfall(false); }} />
            <Input label="SALE DATE" type="date"
              value={soldDate}
              onChange={e => setSoldDate(e.target.value)} />
          </div>

          {/* Live-Vorschau Payout / Profit */}
          {Number(soldPrice) > 0 && soldModal && (() => {
            const con = consignments.find(c => c.id === soldModal);
            if (!con) return null;
            const sp = Number(soldPrice);
            // v0.7.21 — SSOT-Economics statt eigener Verzweigung (cost_split inkl.).
            const econ = computeConsignmentSale(con, sp);
            const comm = econ.commission;
            const po = econ.payout;
            const modelLabel = commissionLineLabel(con);
            return (
              <div className="rounded font-mono" style={{
                padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
              }}>
                <div className="flex justify-between" style={{ marginBottom: 8 }}>
                  <span style={{ color: '#6B7280' }}>{modelLabel}</span>
                  <span style={{ color: comm < 0 ? '#DC2626' : '#0F0F10' }}><Bhd v={comm}/> BHD</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6B7280' }}>Payout to consignor</span>
                  <span style={{ color: '#7EAA6E' }}><Bhd v={po}/> BHD</span>
                </div>
              </div>
            );
          })()}

          {/* Buyer == Consignor — Hard-Block (logischer Fehler, kein Verkauf an sich selbst) */}
          {soldValidation.buyerIsConsignor && (
            <div style={{
              padding: '12px 14px', borderRadius: 8,
              background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.40)',
              fontSize: 12, color: '#DC2626',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Buyer cannot be the same as the consignor
              </div>
              <div style={{ color: '#7A2A2A' }}>
                If the consignor is taking the item back, use <strong>Return</strong> instead — no invoice/purchase needed.
              </div>
            </div>
          )}

          {/* Shortfall-Warning + Acknowledge-Checkbox */}
          {soldValidation.needsAck && (
            <div style={{
              padding: '12px 14px', borderRadius: 8,
              background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.30)',
              fontSize: 12, color: '#DC2626',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                ⚠ Sale <Bhd v={soldValidation.shortfall}/> BHD below agreed price
              </div>
              <div style={{ marginBottom: 10, color: '#7A2A2A' }}>
                Consignor will still receive the full agreed <Bhd v={soldValidation.agreed}/> BHD —
                the <Bhd v={soldValidation.shortfall}/> BHD difference will be recorded as
                a <strong>Consignor Loss</strong> expense.
              </div>
              <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 12 }}>
                <input type="checkbox"
                  checked={soldAckShortfall}
                  onChange={e => setSoldAckShortfall(e.target.checked)} />
                <span>I confirm — record this shortfall as Consignor Loss</span>
              </label>
            </div>
          )}

          {/* Notes */}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea
              placeholder="Reference, payment terms, …"
              value={soldNotes}
              onChange={e => setSoldNotes(e.target.value)}
              className="w-full"
              style={{
                background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6,
                padding: '8px 10px', fontSize: 13, color: '#0F0F10',
                resize: 'vertical', minHeight: 50,
              }}
            />
          </div>

          <div style={{
            padding: '10px 12px', borderRadius: 6,
            background: '#F2F7FA', border: '1px solid #E5E9EE',
            fontSize: 11, color: '#6B7280', lineHeight: 1.4,
          }}>
            On save: <strong>Auto-Invoice</strong> created for buyer · <strong>Auto-Purchase</strong> created
            for consignor (as supplier) · payment via /invoices &amp; /purchases.
          </div>

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setSoldModal(null); setSoldAckShortfall(false); }}>Cancel</Button>
            <Button variant="primary" onClick={handleRecordSale}
              disabled={
                !soldPrice ||
                !soldBuyerId ||
                soldValidation.buyerIsConsignor ||
                (soldValidation.needsAck && !soldAckShortfall)
              }
            >Confirm Sale</Button>
          </div>
        </div>
      </Modal>

      <QuickCustomerModal
        open={showQuickBuyer}
        onClose={() => setShowQuickBuyer(false)}
        onCreated={(id) => { loadCustomers(); setSoldBuyerId(id); }}
      />

      <PrintItemsFilterModal
        open={showPrintAll}
        onClose={() => setShowPrintAll(false)}
        kind="consignment"
        scope="all"
        contextLabel={`${consignorAggregates.length} consignor${consignorAggregates.length === 1 ? '' : 's'}`}
        onConfirm={(filter: ItemListFilter) => {
          const involvedConsignorIds = new Set(consignments.map(c => c.consignorId));
          const consignors = customers.filter(c => involvedConsignorIds.has(c.id));
          runConsignmentPrint({
            filter,
            scope: 'aggregate',
            consignors,
            consignments,
            products,
            categories,
          });
        }}
      />

      {/* ── Mark Paid Out Modal ── */}
      <Modal open={!!paidModal} onClose={() => setPaidModal(null)} title="Pay Out Consignor" width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {paidModal && (() => {
            const con = consignments.find(c => c.id === paidModal);
            if (!con) return null;
            const cust = getCustomer(con.consignorId);
            return (
              <div className="rounded font-mono" style={{
                padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13,
              }}>
                <div className="flex justify-between" style={{ marginBottom: 8 }}>
                  <span style={{ color: '#6B7280' }}>Consignor</span>
                  <span style={{ color: '#0F0F10' }}>{cust ? `${cust.firstName} ${cust.lastName}` : '\u2014'}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6B7280' }}>Payout Amount</span>
                  <span style={{ color: '#7EAA6E' }}><Bhd v={con.payoutAmount || 0}/> BHD</span>
                </div>
              </div>
            );
          })()}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>PAYMENT METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {['bank_transfer', 'cash', 'card', 'benefit'].map(m => (
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
          <div className="flex justify-end gap-3" style={{ paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setPaidModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleMarkPaid}>Confirm Payout</Button>
          </div>
        </div>
      </Modal>

      <DuplicateWarningModal
        open={duplicateMatches.length > 0}
        matches={duplicateMatches}
        candidate={productForm}
        onCancel={() => { lastDismissedFp.current = consignFp; setDuplicateMatches([]); }}
        onCreateAnyway={doCreate}
        onPickExisting={(id) => { setDuplicateMatches([]); setShowNew(false); navigate(`/collection/${id}`); }}
        onCopyDetails={(id) => {
          const src = products.find(p => p.id === id);
          if (!src) return;
          const srcAttrs = { ...(src.attributes || {}) } as Record<string, unknown>;
          delete srcAttrs.serial_number; delete srcAttrs.serialNo;
          setProductForm(f => ({
            ...f,
            brand: src.brand,
            name: src.name,
            categoryId: src.categoryId,
            condition: src.condition,
            taxScheme: src.taxScheme,
            plannedSalePrice: src.plannedSalePrice,
            minSalePrice: src.minSalePrice,
            maxSalePrice: src.maxSalePrice,
            scopeOfDelivery: [...(src.scopeOfDelivery || [])],
            notes: src.notes,
            images: (f.images && f.images.length > 0) ? f.images : [...(src.images || [])],
            attributes: { ...(f.attributes || {}), ...srcAttrs } as typeof f.attributes,
          }));
          setSelectedCat(categories.find(c => c.id === src.categoryId) || null);
          lastDismissedFp.current = consignFp;
          setDuplicateMatches([]);
        }}
      />
    </PageLayout>
  );
}
