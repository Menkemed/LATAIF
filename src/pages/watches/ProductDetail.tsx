import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Package, Trash2, Save, Tag, Sparkles, AlertTriangle, ChevronDown, BarChart3, PieChart, Receipt, Factory } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SkuInput } from '@/components/ui/SkuInput';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useRepairStore, computeRepairTotalCost, sumOpenRepairLineCosts } from '@/stores/repairStore';
import { getLotsWithPurchaseNumbers } from '@/core/lots/lot-queries';
import { query } from '@/core/db/helpers';
import { usePermission } from '@/hooks/usePermission';
import { vatEngine } from '@/core/tax/vat-engine';
import { printHangtag } from '@/core/pdf/hangtag';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import type { Product, TaxScheme, StockStatus } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/collection');
  const { products, categories, loadProducts, loadCategories, updateProduct, deleteProduct, nextAvailableSku, isSkuTaken } = useProductStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  const { repairs, loadRepairs } = useRepairStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Product>>({});
  const [formAttrs, setFormAttrs] = useState<Record<string, string | number | boolean | string[]>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [lotsExpanded, setLotsExpanded] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const perm = usePermission();

  useEffect(() => { loadCategories(); loadProducts(); loadRepairs(); loadInvoices(); loadPurchases(); }, [loadCategories, loadProducts, loadRepairs, loadInvoices, loadPurchases]);

  // Plan §Repair §Own-Item: alle Repairs die mit diesem Produkt verlinkt sind —
  // werden in einer eigenen Section unten angezeigt (Cost-Historie + Issue + Datum).
  const productRepairs = useMemo(
    () => repairs.filter(r => r.productId === id).sort((a, b) =>
      (b.receivedAt || b.createdAt || '').localeCompare(a.receivedAt || a.createdAt || '')
    ),
    [repairs, id],
  );

  const product = useMemo(() => products.find(p => p.id === id), [products, id]);

  // Phase 6 — Stock-Lots fuer Display: zeigt alle aktiven Lots mit Source-Purchase
  // + Supplier in eigener Card. Macht sichtbar dass das Produkt mehrere Kaufpreise
  // und/oder mehrere Lieferanten hatte.
  const productLots = useMemo(() => {
    if (!id) return [];
    const lots = getLotsWithPurchaseNumbers(id);
    // Defensive (2026-05-17): Bei nicht-verfügbaren Produkt-Status ist jeder
    // Lot-Bestand konzeptionell ungültig (Daten-Inkonsistenz möglich). Die Card
    // wird ausgeblendet, damit kein "Available"-Badge bei verkauften Items steht.
    const p = products.find(pp => pp.id === id);
    if (p && ['sold', 'reserved', 'consignment_reserved', 'consumed'].includes(p.stockStatus)) {
      return [];
    }
    return lots;
  }, [id, products]);

  // Aggregat-KPIs ueber alle aktiven Lots — fuer die Tile-Reihe oberhalb der
  // Stock-Lots-Card. Quantity = Summe Restbestaende, Total Cost = sum(unitCost*qty),
  // Cost Range = min/max unitCost, Average = gewichtetes Mittel.
  const lotKpis = useMemo(() => {
    if (productLots.length === 0) return null;
    let qty = 0, totalCost = 0, min = Infinity, max = 0;
    for (const l of productLots) {
      qty += l.qtyRemaining;
      totalCost += l.unitCost * l.qtyRemaining;
      if (l.unitCost < min) min = l.unitCost;
      if (l.unitCost > max) max = l.unitCost;
    }
    return {
      qty,
      totalCost,
      minCost: min === Infinity ? 0 : min,
      maxCost: max,
      avgCost: qty > 0 ? totalCost / qty : 0,
      hasRange: min !== max,
    };
  }, [productLots]);

  // Sales-History: echte Sales (FINAL = bezahlt, PARTIAL = mit Anzahlung).
  // DRAFT/CANCELLED/RETURNED ausgeblendet — entweder kein Commitment oder
  // schon storniert. PARTIAL → FINAL ist dieselbe invoice_id, also keine
  // Doppelung — die Zeile aendert nur Status + Nummer.
  // Reihenfolge: neueste zuerst.
  const productSales = useMemo(() => {
    if (!id) return [] as Array<{
      invoiceId: string; invoiceNumber: string; status: string; specialMark: boolean;
      issuedAt: string; customerName: string;
      unitPrice: number; quantity: number; lineTotal: number;
    }>;
    const rows = query(
      `SELECT i.id AS inv_id, i.invoice_number, i.status, i.special_mark, i.issued_at,
              c.first_name, c.last_name,
              il.unit_price, il.quantity, il.line_total
         FROM invoice_lines il
         JOIN invoices i ON i.id = il.invoice_id
         LEFT JOIN customers c ON c.id = i.customer_id
        WHERE il.product_id = ?
          AND i.status IN ('FINAL', 'PARTIAL')
        ORDER BY i.issued_at DESC, i.created_at DESC`,
      [id]
    );
    return rows.map(r => ({
      invoiceId: r.inv_id as string,
      invoiceNumber: r.invoice_number as string,
      status: (r.status as string) || '',
      specialMark: Number(r.special_mark) === 1,
      issuedAt: (r.issued_at as string) || '',
      customerName: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || '—',
      unitPrice: Number(r.unit_price) || 0,
      quantity: Number(r.quantity) || 1,
      lineTotal: Number(r.line_total) || 0,
    }));
    // Dep auf `invoices` damit Status-Updates (PARTIAL→FINAL via recordPayment)
    // den re-query triggern und die Zeile in der Tabelle aktualisieren.
  }, [id, invoices]);

  // Purchase History — alle Purchases die dieses Produkt enthalten.
  // DRAFT/CANCELLED ausgeblendet (kein Commitment bzw. storniert).
  // Reihenfolge: neueste zuerst (purchase_date DESC).
  const productPurchases = useMemo(() => {
    if (!id) return [] as Array<{
      purchaseId: string; purchaseNumber: string; status: string;
      purchaseDate: string; supplierName: string;
      unitPrice: number; quantity: number; lineTotal: number;
    }>;
    const rows = query(
      `SELECT p.id AS pur_id, p.purchase_number, p.status, p.purchase_date,
              s.name AS supplier_name,
              pl.unit_price, pl.quantity, pl.line_total
         FROM purchase_lines pl
         JOIN purchases p ON p.id = pl.purchase_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE pl.product_id = ?
          AND p.status NOT IN ('DRAFT', 'CANCELLED')
        ORDER BY p.purchase_date DESC, p.created_at DESC`,
      [id]
    );
    return rows.map(r => ({
      purchaseId: r.pur_id as string,
      purchaseNumber: r.purchase_number as string,
      status: (r.status as string) || '',
      purchaseDate: (r.purchase_date as string) || '',
      supplierName: (r.supplier_name as string) || '—',
      unitPrice: Number(r.unit_price) || 0,
      quantity: Number(r.quantity) || 1,
      lineTotal: Number(r.line_total) || 0,
    }));
    // Dep auf `purchases` damit Status-Updates (UNPAID→PAID via recordPayment)
    // den re-query triggern und die Zeile in der Tabelle aktualisieren.
  }, [id, purchases]);

  // Production-History (2026-05-18): Jedes Produkt — egal ob Input oder Output —
  // soll zeigen welche PRD-Records es beruehren. Wir bauen pro PRD eine Zeile,
  // teilen direction = 'input' (konsumiert) oder 'output' (entstanden aus), und
  // listen die "andere Seite" (bei input: erzeugte Outputs, bei output: konsumierte
  // Inputs) als Mini-Liste.
  const productionHistory = useMemo(() => {
    if (!id) return [] as Array<{
      recordId: string; recordNumber: string; productionDate: string;
      direction: 'input' | 'output';
      value: number;                                    // input_value bzw. output_value dieser Zeile
      counterpart: Array<{ productId: string; label: string; value: number }>;
    }>;
    const out: Array<{
      recordId: string; recordNumber: string; productionDate: string;
      direction: 'input' | 'output'; value: number;
      counterpart: Array<{ productId: string; label: string; value: number }>;
    }> = [];

    // INPUT-Seite: dieses Produkt wurde in PRD X konsumiert.
    const inputRows = query(
      `SELECT pi.record_id, pi.input_value,
              pr.record_number, pr.production_date
         FROM production_inputs pi
         JOIN production_records pr ON pr.id = pi.record_id
        WHERE pi.product_id = ?
        ORDER BY pr.production_date DESC, pr.created_at DESC`,
      [id]
    );
    for (const r of inputRows) {
      const recId = r.record_id as string;
      // Gegenstuecke = die Outputs des selben Records
      const counterRows = query(
        `SELECT po.product_id, po.output_value, p.brand, p.name
           FROM production_outputs po
           LEFT JOIN products p ON p.id = po.product_id
          WHERE po.record_id = ?`,
        [recId]
      );
      out.push({
        recordId: recId,
        recordNumber: (r.record_number as string) || '—',
        productionDate: (r.production_date as string) || '',
        direction: 'input',
        value: Number(r.input_value) || 0,
        counterpart: counterRows.map(cr => ({
          productId: (cr.product_id as string) || '',
          label: [cr.brand, cr.name].filter(Boolean).join(' ').trim() || '(deleted)',
          value: Number(cr.output_value) || 0,
        })),
      });
    }

    // OUTPUT-Seite: dieses Produkt ist in PRD X entstanden.
    const outputRows = query(
      `SELECT po.record_id, po.output_value,
              pr.record_number, pr.production_date
         FROM production_outputs po
         JOIN production_records pr ON pr.id = po.record_id
        WHERE po.product_id = ?
        ORDER BY pr.production_date DESC, pr.created_at DESC`,
      [id]
    );
    for (const r of outputRows) {
      const recId = r.record_id as string;
      // Gegenstuecke = die Inputs des selben Records (mit Snapshot-Fallback)
      const counterRows = query(
        `SELECT pi.product_id, pi.input_value, pi.product_snapshot, p.brand, p.name
           FROM production_inputs pi
           LEFT JOIN products p ON p.id = pi.product_id
          WHERE pi.record_id = ?`,
        [recId]
      );
      out.push({
        recordId: recId,
        recordNumber: (r.record_number as string) || '—',
        productionDate: (r.production_date as string) || '',
        direction: 'output',
        value: Number(r.output_value) || 0,
        counterpart: counterRows.map(cr => {
          let label = [cr.brand, cr.name].filter(Boolean).join(' ').trim();
          if (!label && cr.product_snapshot) {
            try {
              const s = JSON.parse(cr.product_snapshot as string);
              label = [s.brand, s.name].filter(Boolean).join(' ').trim();
            } catch { /* */ }
          }
          return {
            productId: (cr.product_id as string) || '',
            label: label || '(deleted)',
            value: Number(cr.input_value) || 0,
          };
        }),
      });
    }

    // Neueste zuerst
    return out.sort((a, b) => (b.productionDate || '').localeCompare(a.productionDate || ''));
  }, [id, products]);

  // Provenance-Fallback: products.supplier_name / paid_from sind Legacy-Spalten,
  // die nur beim INITIAL anlegen via "New Item"-Form gesetzt werden. Wird das
  // Produkt spaeter ueber "Existing Product" in weiteren Purchases verwendet,
  // bleibt diese Spalte leer — aber die Info liegt am Lot → Purchase → Supplier /
  // purchase_payments.method. Hier sammeln wir die distinct Werte ueber ALLE
  // aktiven Lots; wenn nur einer existiert, zeigen wir den. Sonst joinen wir
  // (z.B. "Swiss Watch LLC, Souq Trader") — damit der User sieht woher die
  // Charge tatsaechlich kommt.
  const lotProvenance = useMemo(() => {
    if (!id) return { supplier: null as string | null, paidFrom: null as string | null };
    const rows = query(
      `SELECT DISTINCT s.name AS supplier_name, pp.method AS paid_method
         FROM stock_lots sl
         LEFT JOIN purchases p ON p.id = sl.purchase_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN purchase_payments pp ON pp.purchase_id = sl.purchase_id
        WHERE sl.product_id = ? AND sl.status != 'CANCELLED'`,
      [id]
    );
    const suppliers = Array.from(new Set(rows.map(r => (r.supplier_name as string | null) || '').filter(Boolean)));
    const methods = Array.from(new Set(rows.map(r => (r.paid_method as string | null) || '').filter(Boolean)));
    return {
      supplier: suppliers.length > 0 ? suppliers.join(', ') : null,
      paidFrom: methods.length > 0 ? methods.map(m => m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : m).join(', ') : null,
    };
  }, [id, products]);
  // Im Edit-Mode: Kategorie aus form.categoryId → Felder passen sich live an.
  // Im Read-Mode: Kategorie aus product.categoryId.
  const category = useMemo(() => {
    const cid = editing ? form.categoryId : product?.categoryId;
    return cid ? categories.find(c => c.id === cid) : null;
  }, [product, categories, editing, form.categoryId]);

  useEffect(() => {
    if (product) {
      setForm({ ...product });
      setFormAttrs({ ...product.attributes });
    }
  }, [product]);

  if (!product) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Product not found</p>
      </div>
    );
  }

  const taxCalc = product.plannedSalePrice
    ? vatEngine.calculateProfit(product.plannedSalePrice, product.purchasePrice, product.taxScheme, 10)
    : null;

  // Required-field labels for the error banner.
  const REQ_LABELS: Record<string, string> = {
    brand: 'Brand',
    name: 'Name / Model',
    categoryId: 'Category',
    condition: 'Condition',
    purchasePrice: 'Purchase Price',
  };

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    // v0.7.16 — Brand/Name nur bei branded-Kategorien Pflicht (analog NewProductModal).
    // v0.7.16 — unbranded: cat-gold-jewelry + cat-accessory.
    const brandedRequired = !(form.categoryId === 'cat-gold-jewelry' || form.categoryId === 'cat-accessory');
    if (brandedRequired) {
      if (!form.brand?.trim()) e.brand = 'Required';
      if (!form.name?.trim()) e.name = 'Required';
    }
    if (!form.categoryId) e.categoryId = 'Pick a category';
    if (!form.condition?.trim()) e.condition = 'Required';
    if (form.purchasePrice == null || isNaN(form.purchasePrice) || form.purchasePrice <= 0) {
      e.purchasePrice = 'Must be > 0';
    }
    if (category) {
      for (const attr of category.attributes) {
        if (!attr.required) continue;
        const v = formAttrs[attr.key];
        const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
        if (empty) e[`attr_${attr.key}`] = 'Required';
      }
    }
    return e;
  }

  function handleSave() {
    if (!id) return;
    // Plan §Quick-Capture (User-Spec): kein blockierendes Required, auch
    // nicht im Edit-Mode. validate() läuft nur noch für visuelle Inline-Hints —
    // Save geht immer durch. Vom Handy soll man jederzeit teil-speichern können,
    // Details kommen wenn sie kommen.
    // EINZIGE Ausnahme: SKU-Duplikate werden hart geblockt (Datenintegrität).
    if (form.sku && isSkuTaken(form.sku, id)) {
      setErrors({ ...validate(), sku: 'Diese SKU / Reference ist bereits vergeben.' });
      return;
    }
    setErrors(validate());
    const margin = form.plannedSalePrice ? form.plannedSalePrice - (form.purchasePrice || 0) : undefined;

    // 2026-05-18 AI-Learning: Wenn dieses Produkt einen AI-Snapshot hat
    // (= letztes Identify), diffen wir die Felder die der User jetzt aendert
    // gegen den Snapshot und loggen die Korrekturen. Beim NAECHSTEN Identify
    // werden diese als Few-Shot mitgegeben damit die AI nicht den gleichen
    // Fehler wieder macht.
    let updatedCorrections: string | undefined;
    if (product?.aiIdentifiedSnapshot) {
      try {
        const snap = JSON.parse(product.aiIdentifiedSnapshot) as {
          brand?: string; name?: string; sku?: string; condition?: string;
          attributes?: Record<string, unknown>;
        };
        const newCorrections: Array<{ field: string; aiSaid: unknown; userChanged: unknown; at: string }> = [];
        const now = new Date().toISOString();
        const compare = (field: string, aiVal: unknown, userVal: unknown) => {
          const a = aiVal === undefined || aiVal === null ? '' : String(aiVal).trim().toLowerCase();
          const u = userVal === undefined || userVal === null ? '' : String(userVal).trim().toLowerCase();
          if (a && a !== u) newCorrections.push({ field, aiSaid: aiVal, userChanged: userVal, at: now });
        };
        compare('brand', snap.brand, form.brand);
        compare('name', snap.name, form.name);
        compare('sku', snap.sku, form.sku);
        compare('condition', snap.condition, form.condition);
        const snapAttrs = snap.attributes || {};
        for (const k of Object.keys(snapAttrs)) {
          compare(`attr.${k}`, snapAttrs[k], formAttrs[k]);
        }
        if (newCorrections.length > 0) {
          let existing: typeof newCorrections = [];
          try {
            if (product.aiCorrections) existing = JSON.parse(product.aiCorrections);
          } catch { /* */ }
          updatedCorrections = JSON.stringify([...existing, ...newCorrections]);
        }
      } catch { /* snapshot parse error → no correction tracking */ }
    }

    updateProduct(id, {
      ...form,
      attributes: formAttrs,
      expectedMargin: margin,
      ...(updatedCorrections ? { aiCorrections: updatedCorrections } as Partial<Product> : {}),
    });
    setEditing(false);
  }

  function labelFor(key: string): string {
    if (REQ_LABELS[key]) return REQ_LABELS[key];
    if (key.startsWith('attr_') && category) {
      const attrKey = key.slice(5);
      const a = category.attributes.find(x => x.key === attrKey);
      return a?.label || attrKey;
    }
    return key;
  }

  function handleDelete() {
    if (!id) return;
    deleteProduct(id);
    navigate('/collection');
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
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...product }); setFormAttrs({ ...product.attributes }); setErrors({}); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={async () => {
                  if (!product) return;
                  const ai = await import('@/core/ai/ai-service');
                  if (!ai.isAiConfigured()) { setAiResult('Set your OpenAI API key in Settings > AI'); return; }
                  setAiLoading(true); setAiResult(null);
                  try {
                    const result = await ai.suggestPrice({ brand: product.brand, name: product.name, condition: product.condition, purchasePrice: product.purchasePrice, attributes: product.attributes });
                    setAiResult(`Suggested: ${result.suggestedPrice} BHD (${result.minPrice}-${result.maxPrice})\n${result.reasoning}`);
                  } catch (e) { setAiResult(String(e)); }
                  setAiLoading(false);
                }} disabled={aiLoading}><Sparkles size={14} /> {aiLoading ? 'Analyzing...' : 'AI Price'}</Button>
                {perm.canEditProducts && <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>}
                <Button variant="ghost" onClick={() => {
                  if (!product) return;
                  const mat = (product.attributes.case_material || product.attributes.material || product.attributes.metal || '') as string;
                  const sz = (product.attributes.case_size || product.attributes.size || product.attributes.size_eu || '') as string;
                  const desc = (product.attributes.description_3 || product.condition || '') as string;
                  printHangtag({
                    sku: product.sku || product.id.slice(0, 12),
                    brand: product.brand,
                    price: product.plannedSalePrice || product.purchasePrice,
                    currency: product.purchaseCurrency || 'BHD',
                    name: product.name,
                    material: mat ? String(mat) : undefined,
                    size: sz ? String(sz) : undefined,
                    description: desc ? String(desc) : undefined,
                  });
                }}><Tag size={14} /> Hangtag</Button>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                <Button variant="primary" onClick={() => navigate(`/offers?product=${id}`)}>Create Offer</Button>
              </>
            )}
          </div>
        </div>

        {/* Validation banner — appears when Save was clicked with missing required fields. */}
        {editing && Object.keys(errors).length > 0 && (
          <div style={{
            marginBottom: 16, padding: '12px 16px', borderRadius: 8,
            background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.30)',
            color: '#DC2626', fontSize: 13,
            display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Please fill in {Object.keys(errors).length} required field{Object.keys(errors).length === 1 ? '' : 's'} before saving:
              </div>
              <ul style={{ margin: '4px 0 0 18px', listStyle: 'disc' }}>
                {Object.entries(errors).map(([key, msg]) => (
                  <li key={key}>
                    <button
                      onClick={() => {
                        const el = document.getElementById(`field-${key}`);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}
                      className="cursor-pointer"
                      style={{ background: 'none', border: 'none', color: '#DC2626', textDecoration: 'underline', padding: 0, fontSize: 13 }}
                    >
                      {labelFor(key)}
                    </button>
                    {' — '}{msg}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* AI Result */}
        {aiResult && (
          <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 8, background: 'rgba(15,15,16,0.06)', border: '1px solid rgba(15,15,16,0.15)' }}>
            <div className="flex justify-between">
              <span style={{ fontSize: 12, color: '#0F0F10', fontWeight: 500 }}>AI Suggestion</span>
              <button onClick={() => setAiResult(null)} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 11 }}>close</button>
            </div>
            <p style={{ fontSize: 13, color: '#0F0F10', marginTop: 6, whiteSpace: 'pre-wrap' }}>{aiResult}</p>
          </div>
        )}

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>
          {/* Image */}
          <div className="rounded-xl" style={{ minHeight: 400, background: '#F2F7FA', border: '1px solid #E5E9EE', overflow: 'hidden' }}>
            {editing ? (
              <div style={{ padding: 20 }}>
                <span className="text-overline" style={{ marginBottom: 12 }}>PHOTOS</span>
                <div style={{ marginTop: 12 }}>
                  <ImageUpload images={form.images || []} onChange={imgs => setForm({ ...form, images: imgs })} maxImages={8} />
                </div>
                {/* Plan §Product §4: AI-Identify auch im Edit-Mode (z.B. für mobile-erfasste Produkte ohne KI). */}
                <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                    <div>
                      <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                        Fills brand, name, category fields, condition, market value from the photo or hints (brand/name/SKU).
                      </div>
                    </div>
                    <button
                      disabled={aiBusy}
                      className="cursor-pointer transition-colors"
                      style={{
                        background: aiBusy ? '#6B7280' : '#0F0F10', color: '#FFFFFF',
                        border: 'none', borderRadius: 8, fontSize: 12, padding: '8px 14px',
                      }}
                      onClick={async () => {
                        const ai = await import('@/core/ai/ai-service');
                        if (!ai.isAiConfigured()) { alert('Set OpenAI API key in Settings > AI'); return; }
                        if (!form.categoryId) { alert('Kein category_id — bitte erst eine Kategorie zuweisen.'); return; }
                        const hasImage = (form.images || []).length > 0;
                        const hasHints = !!form.brand || !!form.name || !!form.sku;
                        if (!hasImage && !hasHints) {
                          alert('Foto oder Brand/Name/SKU eintragen, dann AI Identify klicken.');
                          return;
                        }
                        setAiBusy(true);
                        try {
                          const result = await ai.identifyProduct({
                            categoryId: form.categoryId as AiCategoryId,
                            imageBase64: hasImage ? form.images![0] : undefined,
                            hints: hasHints ? { brand: form.brand, name: form.name, reference: form.sku } : undefined,
                          });
                          setForm(f => {
                            const updated = { ...f };
                            if (result.brand) updated.brand = result.brand;
                            if (result.name) updated.name = result.name;
                            if (result.sku && !f.sku) updated.sku = nextAvailableSku(result.sku);
                            if (result.condition) updated.condition = result.condition;
                            if (result.description) updated.notes = f.notes ? `${f.notes}\n\n${result.description}` : result.description;
                            if (result.estimatedValue && !f.plannedSalePrice) updated.plannedSalePrice = result.estimatedValue;
                            if (result.purchasePriceEstimate && !f.purchasePrice) updated.purchasePrice = result.purchasePriceEstimate;
                            if (result.minSalePrice && !f.minSalePrice) updated.minSalePrice = result.minSalePrice;
                            if (result.maxSalePrice && !f.maxSalePrice) updated.maxSalePrice = result.maxSalePrice;
                            if (result.taxScheme && !f.taxScheme) updated.taxScheme = result.taxScheme;
                            if (result.storageLocation && !f.storageLocation) updated.storageLocation = result.storageLocation;
                            if (Array.isArray(result.scopeOfDelivery) && result.scopeOfDelivery.length > 0 && (!f.scopeOfDelivery || f.scopeOfDelivery.length === 0)) {
                              updated.scopeOfDelivery = result.scopeOfDelivery;
                            }
                            return updated;
                          });
                          // Kategorie-Attribute in formAttrs mergen (separater state in ProductDetail)
                          setFormAttrs(a => {
                            const next = { ...a };
                            for (const [k, v] of Object.entries(result.attributes || {})) {
                              if (v === null || v === undefined || v === '') continue;
                              next[k] = v as string | number | boolean | string[];
                            }
                            return next;
                          });
                        } catch (e) { alert(String(e)); }
                        finally { setAiBusy(false); }
                      }}
                    >{aiBusy ? 'Researching…' : 'AI Identify'}</button>
                  </div>
                </div>
              </div>
            ) : product.images.length > 0 ? (
              <img src={product.images[0]} alt="" style={{ width: '100%', height: 400, objectFit: 'cover' }} />
            ) : (
              <div className="flex items-center justify-center" style={{ height: 400 }}>
                <Package size={64} strokeWidth={0.8} style={{ color: '#6B7280' }} />
              </div>
            )}
            {!editing && product.images.length > 1 && (
              <div className="flex gap-2" style={{ padding: '8px 12px', borderTop: '1px solid #E5E9EE' }}>
                {product.images.slice(1, 5).map((img, i) => (
                  <div key={i} className="rounded" style={{ width: 56, height: 56, overflow: 'hidden', border: '1px solid #E5E9EE' }}>
                    <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))}
                {product.images.length > 5 && (
                  <div className="rounded flex items-center justify-center" style={{ width: 56, height: 56, background: '#FFFFFF', border: '1px solid #E5E9EE', fontSize: 11, color: '#6B7280' }}>
                    +{product.images.length - 5}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Key Info */}
          <div>
            {category && (
              <span style={{ fontSize: 11, padding: '3px 12px', borderRadius: 999, background: category.color + '15', color: category.color, border: `1px solid ${category.color}30`, display: 'inline-block', marginBottom: 16 }}>{category.name}</span>
            )}

            {editing ? (
              <>
                {/* Category Selector — wechseln bewirkt dass sich die "Specifications"-Karte unten anpasst. */}
                <div id="field-categoryId" style={{ marginBottom: 16, padding: errors.categoryId ? 8 : 0, border: errors.categoryId ? '1px solid #DC2626' : 'none', borderRadius: 8 }}>
                  <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>CATEGORY *</span>
                  <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                    {categories.map(cat => {
                      const active = form.categoryId === cat.id;
                      return (
                        <button key={cat.id} onClick={() => {
                          // Beim Wechsel: Attributes zurücksetzen — alte Werte würden eh keine passenden Spalten mehr haben.
                          setForm({
                            ...form,
                            categoryId: cat.id,
                            condition: active ? form.condition : (cat.conditionOptions?.[0] || ''),
                          });
                          if (!active) setFormAttrs({});
                          if (errors.categoryId) setErrors({ ...errors, categoryId: '' });
                        }}
                          className="cursor-pointer rounded-lg transition-all"
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                {(() => {
                  // v0.7.16 — Brand/Name optional bei unbranded Gold-Schmuck.
                  // v0.7.16 — unbranded: cat-gold-jewelry + cat-accessory.
    const brandedRequired = !(form.categoryId === 'cat-gold-jewelry' || form.categoryId === 'cat-accessory');
                  return (
                    <>
                      <div id="field-brand">
                        <Input label={brandedRequired ? 'BRAND *' : 'BRAND (OPTIONAL)'}
                          value={form.brand || ''} error={errors.brand}
                          onChange={e => { setForm({ ...form, brand: e.target.value }); if (errors.brand) setErrors({ ...errors, brand: '' }); }} />
                      </div>
                      <div id="field-name">
                        <Input label={brandedRequired ? 'NAME / MODEL *' : 'NAME / MODEL (OPTIONAL)'}
                          value={form.name || ''} error={errors.name}
                          onChange={e => { setForm({ ...form, name: e.target.value }); if (errors.name) setErrors({ ...errors, name: '' }); }} />
                      </div>
                    </>
                  );
                })()}
                <SkuInput value={form.sku || ''} onChange={v => { setForm({ ...form, sku: v }); if (errors.sku) setErrors({ ...errors, sku: '' }); }} excludeProductId={id} />
                <Input label="QUANTITY (UNITS)" type="number" min="0"
                  value={form.quantity ?? 1}
                  onChange={e => setForm({ ...form, quantity: Math.max(0, Number(e.target.value) || 0) })} />
                <div>
                  <span className="text-overline" style={{ marginBottom: 6 }}>STATUS</span>
                  <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                    {(['in_stock', 'reserved', 'offered', 'sold', 'consignment'] as StockStatus[]).map(s => (
                      <button key={s} onClick={() => setForm({ ...form, stockStatus: s })}
                        className="cursor-pointer" style={{
                          padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                          background: form.stockStatus === s ? 'rgba(15,15,16,0.1)' : 'transparent',
                          color: form.stockStatus === s ? '#0F0F10' : '#6B7280',
                        }}>{s.replace('_', ' ')}</button>
                    ))}
                  </div>
                </div>
              </div>
              </>
            ) : (
              <>
                <span className="text-overline">{product.brand}</span>
                <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>{product.name}</h1>
                {product.sku && <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 8 }}>{product.sku}</span>}
                <div className="flex items-center gap-4" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  <StatusDot status={product.stockStatus} />
                  {(() => {
                    // Phase 7: Stueck-Anzahl aus aktiven Lots (echte verfuegbare Stuecke),
                    // Fallback auf legacy product.quantity wenn keine Lots existieren.
                    const lotQty = productLots.reduce((s, l) => s + l.qtyRemaining, 0);
                    const qty = lotQty > 0 ? lotQty : (product.quantity || 1);
                    if (qty <= 1) return null;
                    return (
                      <span className="font-mono" style={{
                        fontSize: 12, color: '#AA956E',
                        padding: '3px 10px', border: '1px solid rgba(170,149,110,0.4)',
                        borderRadius: 999,
                      }}>x {qty}</span>
                    );
                  })()}
                  {product.condition && <span style={{ fontSize: 13, color: '#4B5563' }}>{product.condition}</span>}
                </div>
                {/* AI-Identifikation Status (2026-05-18) — Confirm-Badge wenn
                    AI das Item identifiziert hat. Bestaetigte Items werden im
                    naechsten Identify als Positive-Few-Shot mitgegeben. */}
                {product.aiIdentifiedSnapshot && (
                  <div style={{ marginTop: 12 }}>
                    {product.aiConfirmedAt ? (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        fontSize: 11, padding: '4px 10px', borderRadius: 999,
                        background: 'rgba(126,170,110,0.10)', color: '#5C8550',
                        border: '1px solid rgba(126,170,110,0.4)',
                      }}>
                        ✓ AI Identification confirmed
                        <span style={{ color: '#9CA3AF', marginLeft: 4 }}>
                          {product.aiConfirmedAt.split('T')[0]}
                        </span>
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          if (!id) return;
                          updateProduct(id, { aiConfirmedAt: new Date().toISOString() } as Partial<Product>);
                        }}
                        className="cursor-pointer transition-all"
                        title="Mark AI Identification as correct — used as positive example next time"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          fontSize: 11, padding: '4px 10px', borderRadius: 999,
                          background: 'rgba(170,149,110,0.08)', color: '#AA956E',
                          border: '1px dashed rgba(170,149,110,0.5)',
                        }}
                      >
                        ✓ Confirm AI Identification
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Prices */}
            <div style={{ marginTop: 28, borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              {editing ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div id="field-purchasePrice">
                    <Input label="PURCHASE PRICE (BHD) *" type="number" value={form.purchasePrice || ''} error={errors.purchasePrice}
                      onChange={e => { setForm({ ...form, purchasePrice: Number(e.target.value) }); if (errors.purchasePrice) setErrors({ ...errors, purchasePrice: '' }); }} />
                  </div>
                  <Input label="SALE PRICE (BHD)" type="number" value={form.plannedSalePrice || ''} onChange={e => setForm({ ...form, plannedSalePrice: Number(e.target.value) || undefined })} />
                  <Input label="MIN SALE PRICE (BHD)" type="number" value={form.minSalePrice || ''} onChange={e => setForm({ ...form, minSalePrice: Number(e.target.value) || undefined })} />
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">PURCHASE PRICE</span>
                    <span className="font-display" style={{ fontSize: 20, color: '#4B5563' }}><Bhd v={product.purchasePrice}/> BHD</span>
                  </div>
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">ASKING PRICE</span>
                    <span className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}><Bhd v={product.plannedSalePrice || 0}/> BHD</span>
                  </div>
                  {product.minSalePrice && product.minSalePrice > 0 && (
                    <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                      <span className="text-overline">MIN SALE PRICE</span>
                      <span className="font-mono" style={{ fontSize: 14, color: '#AA956E' }}>
                        <Bhd v={product.minSalePrice}/> BHD
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline" style={{ marginBottom: 10 }}>
                    <span className="text-overline">EXPECTED MARGIN</span>
                    <span className="font-mono" style={{ fontSize: 16, color: (product.expectedMargin || 0) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                      <Bhd v={product.expectedMargin || 0}/> BHD
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Tax */}
            <div style={{ marginTop: 16, padding: '12px 14px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div className="flex justify-between items-center" style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: '#6B7280' }}>Tax Scheme</span>
                {editing ? (
                  <div className="flex gap-1">
                    {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(s => (
                      <button key={s} onClick={() => setForm({ ...form, taxScheme: s })}
                        className="cursor-pointer" style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: 'none', background: form.taxScheme === s ? 'rgba(15,15,16,0.1)' : 'transparent', color: form.taxScheme === s ? '#0F0F10' : '#6B7280' }}>{s === 'VAT_10' ? 'VAT 10%' : s}</button>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: '#0F0F10' }}>{product.taxScheme === 'MARGIN' ? 'Margin Scheme' : product.taxScheme === 'VAT_10' ? 'Standard VAT' : 'Exempt'}</span>
                )}
              </div>
              {taxCalc && !editing && (
                <>
                  <div className="flex justify-between" style={{ fontSize: 12 }}>
                    <span style={{ color: '#6B7280' }}>VAT Liability</span>
                    <span className="font-mono" style={{ color: '#AA956E' }}><Bhd v={taxCalc.vatLiability}/> BHD</span>
                  </div>
                  <div className="flex justify-between" style={{ fontSize: 12, marginTop: 2 }}>
                    <span style={{ color: '#6B7280' }}>Net Profit</span>
                    <span className="font-mono" style={{ color: taxCalc.netProfit >= 0 ? '#7EAA6E' : '#AA6E6E' }}><Bhd v={taxCalc.netProfit}/> BHD</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Lot-Aggregat-KPIs: Quantity / Total Cost / Cost Range / Average Cost */}
        {!editing && lotKpis && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <Card style={{ padding: 14 }}>
              <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: '#F3EEFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Package size={12} color="#7E5BEF" />
                </div>
                <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.04em' }}>Quantity in Stock</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, color: '#0F0F10' }}>{lotKpis.qty}</div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>piece{lotKpis.qty === 1 ? '' : 's'}</div>
            </Card>
            <Card style={{ padding: 14 }}>
              <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: '#F3EEFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Tag size={12} color="#7E5BEF" />
                </div>
                <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.04em' }}>Total Stock Cost</span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#0F0F10' }}><Bhd v={lotKpis.totalCost}/></div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>BHD</div>
            </Card>
            <Card style={{ padding: 14 }}>
              <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: '#F3EEFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <BarChart3 size={12} color="#7E5BEF" />
                </div>
                <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.04em' }}>Cost Range</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10', lineHeight: 1.2 }}>
                {lotKpis.hasRange ? (<><Bhd v={lotKpis.minCost}/> – <Bhd v={lotKpis.maxCost}/></>) : <Bhd v={lotKpis.minCost}/>}
              </div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>BHD</div>
            </Card>
            <Card style={{ padding: 14 }}>
              <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: '#F3EEFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <PieChart size={12} color="#7E5BEF" />
                </div>
                <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.04em' }}>Average Cost</span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#0F0F10' }}><Bhd v={lotKpis.avgCost}/></div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>BHD</div>
            </Card>
          </div>
        )}

        {/* Stock Lots — collapsible Card (Sidebar-Style) mit Supplier-Provenance pro Lot */}
        {!editing && productLots.length > 0 && (
          <Card style={{ marginBottom: 32, padding: 0, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setLotsExpanded(v => !v)}
              style={{
                width: '100%',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 14px',
                background: 'transparent',
                border: 'none',
                borderBottom: lotsExpanded ? '1px solid #E5E9EE' : 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div className="flex items-center gap-2">
                <div style={{ width: 22, height: 22, borderRadius: 6, background: '#F3EEFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Package size={12} color="#7E5BEF" />
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Stock Lots</span>
                <span style={{ fontSize: 11, color: '#9CA3AF' }}>({productLots.length})</span>
              </div>
              <ChevronDown
                size={14}
                color="#6B7280"
                style={{ transform: lotsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}
              />
            </button>
            {lotsExpanded && (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: '#FAFBFC' }}>
                        <th style={{ textAlign: 'left', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Purchase Ref</th>
                        <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Date</th>
                        <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Supplier</th>
                        <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Qty</th>
                        <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Unit Cost</th>
                        <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Total Cost</th>
                        <th style={{ textAlign: 'center', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productLots.map(l => {
                        const clickable = !!l.purchaseId;
                        const total = l.unitCost * l.qtyRemaining;
                        const statusLabel = l.status === 'ACTIVE' ? 'Available' : l.status === 'EXHAUSTED' ? 'Sold Out' : 'Cancelled';
                        const statusBg = l.status === 'ACTIVE' ? '#ECFDF5' : l.status === 'EXHAUSTED' ? '#F3F4F6' : '#FEF2F2';
                        const statusFg = l.status === 'ACTIVE' ? '#047857' : l.status === 'EXHAUSTED' ? '#6B7280' : '#B91C1C';
                        const statusBorder = l.status === 'ACTIVE' ? '#A7F3D0' : l.status === 'EXHAUSTED' ? '#D5D9DE' : '#FECACA';
                        return (
                          <tr
                            key={l.id}
                            onClick={() => clickable && navigate(`/purchases/${l.purchaseId}`)}
                            title={clickable ? `Open purchase ${l.purchaseNumber || ''}` : 'No purchase linked'}
                            style={{
                              borderTop: '1px solid #F3F4F6',
                              cursor: clickable ? 'pointer' : 'default',
                              transition: 'background 0.12s',
                            }}
                            onMouseEnter={e => { if (clickable) e.currentTarget.style.background = '#FAFBFC'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <td style={{ padding: '8px 14px', color: '#0F0F10', fontFamily: 'monospace', fontSize: 11 }}>{l.purchaseNumber || '—'}</td>
                            <td style={{ padding: '8px 10px', color: '#4B5563' }}>{l.acquiredAt}</td>
                            <td style={{ padding: '8px 10px', color: '#0F0F10' }}>{l.supplierName || <span style={{ color: '#9CA3AF' }}>— no supplier</span>}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: '#4B5563' }}>{l.qtyRemaining}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: '#0F0F10', fontFamily: 'monospace' }}>{fmt(l.unitCost)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', color: '#0F0F10', fontFamily: 'monospace' }}>{fmt(total)}</td>
                            <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                              <span style={{
                                display: 'inline-block', padding: '2px 8px',
                                fontSize: 10, fontWeight: 500,
                                borderRadius: 999,
                                background: statusBg, color: statusFg, border: `1px solid ${statusBorder}`,
                              }}>{statusLabel}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: '6px 14px', fontSize: 10, color: '#9CA3AF', textAlign: 'center', borderTop: '1px solid #F3F4F6', background: '#FAFBFC' }}>
                  {productLots.length} lot{productLots.length === 1 ? '' : 's'}
                </div>
              </>
            )}
          </Card>
        )}

        {/* Sales History — alle Invoices mit diesem Produkt, neueste zuerst.
            Klick auf Zeile öffnet die Invoice. */}
        {!editing && productSales.length > 0 && (
          <Card style={{ marginBottom: 32, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 22, height: 22, borderRadius: 6, background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Receipt size={12} color="#3D7FFF" />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Sales History</span>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>({productSales.length})</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#FAFBFC' }}>
                    <th style={{ textAlign: 'left', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Invoice</th>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Customer</th>
                    <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Qty</th>
                    <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Unit Price</th>
                    <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Total</th>
                    <th style={{ textAlign: 'center', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {productSales.map(s => {
                    const labelMap: Record<string, { label: string; bg: string; fg: string; border: string }> = {
                      FINAL:     { label: 'Paid',           bg: '#ECFDF5', fg: '#047857', border: '#A7F3D0' },
                      PARTIAL:   { label: 'Partially Paid', bg: '#FFF7ED', fg: '#9A3412', border: '#FED7AA' },
                      DRAFT:     { label: 'Draft',          bg: '#F3F4F6', fg: '#6B7280', border: '#D5D9DE' },
                      CANCELLED: { label: 'Cancelled',      bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA' },
                      RETURNED:  { label: 'Returned',       bg: '#F3EEFF', fg: '#6D28D9', border: '#DDD6FE' },
                    };
                    const meta = labelMap[s.status] || { label: s.status, bg: '#F3F4F6', fg: '#6B7280', border: '#D5D9DE' };
                    const dateOnly = s.issuedAt ? s.issuedAt.split('T')[0] : '—';
                    return (
                      <tr key={s.invoiceId}
                        onClick={() => navigate(`/invoices/${s.invoiceId}`)}
                        title={`Open invoice ${s.invoiceNumber}`}
                        style={{ borderTop: '1px solid #F3F4F6', cursor: 'pointer', transition: 'background 0.12s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#FAFBFC'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                        <td style={{ padding: '8px 14px', color: '#3D7FFF', fontFamily: 'monospace', fontSize: 11 }}>{formatInvoiceDisplayShort(s) || s.invoiceNumber}</td>
                        <td style={{ padding: '8px 10px', color: '#4B5563' }}>{dateOnly}</td>
                        <td style={{ padding: '8px 10px', color: '#0F0F10' }}>{s.customerName}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#4B5563' }}>{s.quantity}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#0F0F10', fontFamily: 'monospace' }}>{fmt(s.unitPrice)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#0F0F10', fontFamily: 'monospace' }}>{fmt(s.lineTotal)}</td>
                        <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px',
                            fontSize: 10, fontWeight: 500, borderRadius: 999,
                            background: meta.bg, color: meta.fg, border: `1px solid ${meta.border}`,
                          }}>{meta.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '6px 14px', fontSize: 10, color: '#9CA3AF', textAlign: 'center', borderTop: '1px solid #F3F4F6', background: '#FAFBFC' }}>
              {productSales.length} invoice{productSales.length === 1 ? '' : 's'}
            </div>
          </Card>
        )}

        {/* Purchase History — alle Purchases mit diesem Produkt, neueste zuerst.
            Klick auf Zeile öffnet die Purchase. */}
        {!editing && productPurchases.length > 0 && (
          <Card style={{ marginBottom: 32, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 22, height: 22, borderRadius: 6, background: '#F0FDF4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Tag size={12} color="#16A34A" />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Purchase History</span>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>({productPurchases.length})</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#FAFBFC' }}>
                    <th style={{ textAlign: 'left', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Purchase</th>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Supplier</th>
                    <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Qty</th>
                    <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Unit Cost</th>
                    <th style={{ textAlign: 'right', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Total</th>
                    <th style={{ textAlign: 'center', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {productPurchases.map(p => {
                    const labelMap: Record<string, { label: string; bg: string; fg: string; border: string }> = {
                      PAID:           { label: 'Paid',           bg: '#ECFDF5', fg: '#047857', border: '#A7F3D0' },
                      PARTIALLY_PAID: { label: 'Partially Paid', bg: '#FFF7ED', fg: '#9A3412', border: '#FED7AA' },
                      UNPAID:         { label: 'Unpaid',         bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA' },
                      DRAFT:          { label: 'Draft',          bg: '#F3F4F6', fg: '#6B7280', border: '#D5D9DE' },
                      CANCELLED:      { label: 'Cancelled',      bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA' },
                    };
                    const meta = labelMap[p.status] || { label: p.status, bg: '#F3F4F6', fg: '#6B7280', border: '#D5D9DE' };
                    const dateOnly = p.purchaseDate ? p.purchaseDate.split('T')[0] : '—';
                    return (
                      <tr key={p.purchaseId}
                        onClick={() => navigate(`/purchases/${p.purchaseId}`)}
                        title={`Open purchase ${p.purchaseNumber}`}
                        style={{ borderTop: '1px solid #F3F4F6', cursor: 'pointer', transition: 'background 0.12s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#FAFBFC'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                        <td style={{ padding: '8px 14px', color: '#16A34A', fontFamily: 'monospace', fontSize: 11 }}>{p.purchaseNumber}</td>
                        <td style={{ padding: '8px 10px', color: '#4B5563' }}>{dateOnly}</td>
                        <td style={{ padding: '8px 10px', color: '#0F0F10' }}>{p.supplierName}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#4B5563' }}>{p.quantity}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#0F0F10', fontFamily: 'monospace' }}>{fmt(p.unitPrice)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#0F0F10', fontFamily: 'monospace' }}>{fmt(p.lineTotal)}</td>
                        <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px',
                            fontSize: 10, fontWeight: 500, borderRadius: 999,
                            background: meta.bg, color: meta.fg, border: `1px solid ${meta.border}`,
                          }}>{meta.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '6px 14px', fontSize: 10, color: '#9CA3AF', textAlign: 'center', borderTop: '1px solid #F3F4F6', background: '#FAFBFC' }}>
              {productPurchases.length} purchase{productPurchases.length === 1 ? '' : 's'}
            </div>
          </Card>
        )}

        {/* Production-History — 2026-05-18: Input-Produkte (status=consumed) sowie
            aus PRD entstandene Output-Produkte zeigen hier ihre PRD-Beteiligung.
            Direction=input → "Consumed in PRD-X (→ produced Y, Z)".
            Direction=output → "Created from PRD-X (← used input A, B)". */}
        {!editing && productionHistory.length > 0 && (
          <Card style={{ marginBottom: 32, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 22, height: 22, borderRadius: 6, background: '#FEF3C7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Factory size={12} color="#92400E" />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Production History</span>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>({productionHistory.length})</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#FAFBFC' }}>
                    <th style={{ textAlign: 'left', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Record</th>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Role</th>
                    <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Counterpart</th>
                    <th style={{ textAlign: 'right', padding: '7px 14px', fontSize: 10, fontWeight: 500, color: '#6B7280', letterSpacing: '0.04em' }}>Value (BHD)</th>
                  </tr>
                </thead>
                <tbody>
                  {productionHistory.map((row, idx) => {
                    const isInput = row.direction === 'input';
                    const roleMeta = isInput
                      ? { label: 'Consumed',  bg: '#FEF3C7', fg: '#92400E', border: '#FCD34D', prefix: '→' }
                      : { label: 'Created',   bg: '#ECFDF5', fg: '#047857', border: '#A7F3D0', prefix: '←' };
                    const dateOnly = row.productionDate ? row.productionDate.split('T')[0] : '—';
                    return (
                      <tr key={`${row.recordId}-${row.direction}-${idx}`}
                        onClick={() => navigate(`/production/${row.recordId}`)}
                        title={`Open production ${row.recordNumber}`}
                        style={{ borderTop: '1px solid #F3F4F6', cursor: 'pointer', transition: 'background 0.12s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#FAFBFC'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                        <td style={{ padding: '8px 14px', color: '#92400E', fontFamily: 'monospace', fontSize: 11 }}>{row.recordNumber}</td>
                        <td style={{ padding: '8px 10px', color: '#4B5563' }}>{dateOnly}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px',
                            fontSize: 10, fontWeight: 500, borderRadius: 999,
                            background: roleMeta.bg, color: roleMeta.fg, border: `1px solid ${roleMeta.border}`,
                          }}>{roleMeta.label}</span>
                        </td>
                        <td style={{ padding: '8px 10px', color: '#0F0F10', maxWidth: 320 }}>
                          {row.counterpart.length === 0 ? (
                            <span style={{ color: '#9CA3AF' }}>—</span>
                          ) : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {row.counterpart.map((c, i) => (
                                <span
                                  key={i}
                                  onClick={e => { if (c.productId) { e.stopPropagation(); navigate(`/collection/${c.productId}`); } }}
                                  style={{
                                    fontSize: 11, padding: '2px 8px', borderRadius: 999,
                                    background: '#F2F7FA', color: '#4B5563', border: '1px solid #E5E9EE',
                                    cursor: c.productId ? 'pointer' : 'default',
                                  }}
                                  title={c.productId ? 'Open product' : 'Counterpart product is no longer available'}
                                >
                                  <span style={{ color: '#9CA3AF', marginRight: 4 }}>{roleMeta.prefix}</span>
                                  {c.label}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '8px 14px', textAlign: 'right', color: '#0F0F10', fontFamily: 'monospace' }}>{fmt(row.value)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '6px 14px', fontSize: 10, color: '#9CA3AF', textAlign: 'center', borderTop: '1px solid #F3F4F6', background: '#FAFBFC' }}>
              {productionHistory.length} production record{productionHistory.length === 1 ? '' : 's'}
            </div>
          </Card>
        )}

        {/* Details Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Category-specific Attributes */}
          {category && category.attributes.length > 0 && (
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>SPECIFICATIONS</span>
              <div style={{ marginTop: 16 }}>
                {category.attributes.map(attr => {
                  const val = editing ? formAttrs[attr.key] : product.attributes[attr.key];

                  if (editing) {
                    const errKey = `attr_${attr.key}`;
                    const hasErr = !!errors[errKey];
                    const reqMark = attr.required ? ' *' : '';
                    // Editable
                    if (attr.type === 'select' && attr.options) {
                      return (
                        <div key={attr.key} id={`field-${errKey}`} style={{ padding: hasErr ? 8 : '8px 0', border: hasErr ? '1px solid #DC2626' : undefined, borderBottom: hasErr ? '1px solid #DC2626' : '1px solid #E5E9EE', borderRadius: hasErr ? 8 : 0 }}>
                          <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 4 }}>{attr.label}{reqMark}</span>
                          <div className="flex flex-wrap gap-1">
                            {attr.options.map(opt => (
                              <button key={opt} onClick={() => { setFormAttrs({ ...formAttrs, [attr.key]: opt }); if (hasErr) setErrors({ ...errors, [errKey]: '' }); }}
                                className="cursor-pointer" style={{
                                  padding: '3px 8px', fontSize: 11, borderRadius: 4, border: 'none',
                                  background: formAttrs[attr.key] === opt ? 'rgba(15,15,16,0.1)' : 'transparent',
                                  color: formAttrs[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                }}>{opt}</button>
                            ))}
                          </div>
                          {hasErr && <span style={{ fontSize: 12, color: '#DC2626', display: 'block', marginTop: 4 }}>{errors[errKey]}</span>}
                        </div>
                      );
                    }
                    // v0.7.14 — Boolean → Yes/No-Toggle.
                    if (attr.type === 'boolean') {
                      const cur = formAttrs[attr.key];
                      return (
                        <div key={attr.key} id={`field-${errKey}`} style={{ padding: hasErr ? 8 : '8px 0', border: hasErr ? '1px solid #DC2626' : undefined, borderBottom: hasErr ? '1px solid #DC2626' : '1px solid #E5E9EE', borderRadius: hasErr ? 8 : 0 }}>
                          <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 4 }}>{attr.label}{reqMark}</span>
                          <div className="flex gap-2">
                            {[true, false].map(opt => (
                              <button key={String(opt)} type="button" onClick={() => { setFormAttrs({ ...formAttrs, [attr.key]: opt }); if (hasErr) setErrors({ ...errors, [errKey]: '' }); }}
                                className="cursor-pointer"
                                style={{
                                  padding: '3px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                                  background: cur === opt ? 'rgba(15,15,16,0.1)' : 'transparent',
                                  color: cur === opt ? '#0F0F10' : '#6B7280',
                                }}>{opt ? 'Yes' : 'No'}</button>
                            ))}
                          </div>
                          {hasErr && <span style={{ fontSize: 12, color: '#DC2626', display: 'block', marginTop: 4 }}>{errors[errKey]}</span>}
                        </div>
                      );
                    }
                    return (
                      <div key={attr.key} id={`field-${errKey}`} style={{ padding: '6px 0', borderBottom: '1px solid #E5E9EE' }}>
                        <Input
                          label={attr.label + (attr.unit ? ` (${attr.unit})` : '') + reqMark}
                          type={attr.type === 'number' ? 'number' : 'text'}
                          value={String(formAttrs[attr.key] || '')}
                          error={errors[errKey]}
                          onChange={e => { setFormAttrs({ ...formAttrs, [attr.key]: attr.type === 'number' ? Number(e.target.value) : e.target.value }); if (hasErr) setErrors({ ...errors, [errKey]: '' }); }}
                        />
                      </div>
                    );
                  }

                  // Read-only — v0.7.14: boolean → Yes/No statt "true"/"false".
                  if (val === undefined || val === null || val === '') return null;
                  const displayVal = attr.type === 'boolean' ? (val ? 'Yes' : 'No') : String(val);
                  return (
                    <div key={attr.key} className="flex justify-between" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
                      <span style={{ fontSize: 13, color: '#6B7280' }}>{attr.label}</span>
                      <span style={{ fontSize: 13, color: '#0F0F10' }}>{displayVal}{attr.unit ? ` ${attr.unit}` : ''}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* General Details */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 16 }}>DETAILS</span>
            <div style={{ marginTop: 16 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Condition */}
                  {category && category.conditionOptions.length > 0 && (
                    <div id="field-condition" style={{ padding: errors.condition ? 8 : 0, border: errors.condition ? '1px solid #DC2626' : 'none', borderRadius: 8 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Condition *</span>
                      <div className="flex flex-wrap gap-1">
                        {category.conditionOptions.map(c => (
                          <button key={c} onClick={() => { setForm({ ...form, condition: c }); if (errors.condition) setErrors({ ...errors, condition: '' }); }}
                            className="cursor-pointer" style={{
                              padding: '4px 10px', fontSize: 11, borderRadius: 4, border: 'none',
                              background: form.condition === c ? 'rgba(15,15,16,0.1)' : 'transparent',
                              color: form.condition === c ? '#0F0F10' : '#6B7280',
                            }}>{c}</button>
                        ))}
                      </div>
                      {errors.condition && <span style={{ fontSize: 12, color: '#DC2626', display: 'block', marginTop: 4 }}>{errors.condition}</span>}
                    </div>
                  )}
                  {/* Scope */}
                  {category && category.scopeOptions.length > 0 && (
                    <div>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Scope of Delivery</span>
                      <div className="flex flex-wrap gap-1">
                        {category.scopeOptions.map(s => {
                          const sel = (form.scopeOfDelivery || []).includes(s);
                          return (
                            <button key={s} onClick={() => {
                              const arr = form.scopeOfDelivery || [];
                              setForm({ ...form, scopeOfDelivery: sel ? arr.filter(x => x !== s) : [...arr, s] });
                            }} className="cursor-pointer" style={{
                              padding: '3px 8px', fontSize: 11, borderRadius: 999,
                              border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                              color: sel ? '#0F0F10' : '#6B7280',
                              background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{s}</button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <Input label="STORAGE LOCATION" value={form.storageLocation || ''} onChange={e => setForm({ ...form, storageLocation: e.target.value })} />
                  <Input label="SUPPLIER" value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} />
                  <Input label="PURCHASE SOURCE" placeholder="Souq, Private seller, Auction..." value={form.purchaseSource || ''} onChange={e => setForm({ ...form, purchaseSource: e.target.value })} />
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>PAID FROM</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
                      {([null, 'cash', 'bank', 'benefit'] as const).map(opt => {
                        const active = (form.paidFrom ?? null) === opt;
                        const label = opt === null ? 'None' : opt === 'cash' ? 'Cash' : opt === 'bank' ? 'Bank' : 'Benefit';
                        return (
                          <button key={String(opt)} type="button" onClick={() => setForm({ ...form, paidFrom: opt })}
                            className="cursor-pointer rounded transition-all duration-200"
                            style={{
                              padding: '7px 14px', fontSize: 12,
                              border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                              color: active ? '#0F0F10' : '#6B7280',
                              background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                            }}>{label}</button>
                        );
                      })}
                    </div>
                  </div>
                  <Input label="PURCHASE DATE" type="date" value={form.purchaseDate || ''} onChange={e => setForm({ ...form, purchaseDate: e.target.value })} />
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
                  {product.scopeOfDelivery.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>Scope of Delivery</span>
                      <div className="flex flex-wrap gap-2">
                        {product.scopeOfDelivery.map(item => (
                          <span key={item} style={{ padding: '4px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #D5D9DE', color: '#4B5563' }}>{item}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(() => {
                    // Phase 7: echte Stueck-Anzahl aus Lots; legacy product.quantity nur als Hinweis
                    // wenn beide existieren und voneinander abweichen (Daten-Skew sichtbar machen).
                    const lotQty = productLots.reduce((s, l) => s + l.qtyRemaining, 0);
                    const legacyQty = product.quantity || 1;
                    const display = lotQty > 0 ? lotQty : legacyQty;
                    const label = `${display} ${display === 1 ? 'piece' : 'pieces'}`;
                    const suffix = lotQty > 0 && lotQty !== legacyQty
                      ? ` (across ${productLots.length} lot${productLots.length === 1 ? '' : 's'})`
                      : '';
                    return renderField('Quantity', label + suffix);
                  })()}
                  {renderField('Condition', product.condition)}
                  {renderField('Storage', product.storageLocation)}
                  {renderField('Source', product.sourceType === 'OWN' ? 'Own' : product.sourceType === 'CONSIGNMENT' ? 'Consignment' : 'Agent')}
                  {renderField('Supplier', product.supplierName || lotProvenance.supplier || undefined)}
                  {renderField('Purchase Source', product.purchaseSource)}
                  {renderField('Paid From', product.paidFrom
                    ? (product.paidFrom === 'cash' ? 'Cash' : 'Bank')
                    : (lotProvenance.paidFrom || undefined))}
                  {renderField('Purchase Date', product.purchaseDate)}
                  {renderField('Days in Stock', product.daysInStock !== undefined ? `${product.daysInStock} days` : undefined)}
                  {product.notes && (
                    <div style={{ marginTop: 16 }}>
                      <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 6 }}>Notes</span>
                      <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{product.notes}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {editing && perm.canDeleteProducts && (
              <div className="flex gap-2" style={{ marginTop: 20 }}>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> Delete Item
                </Button>
              </div>
            )}
          </Card>
        </div>

        {/* Repair History — alle Repairs (CUSTOMER + OWN) die dieses Produkt
            betreffen. Bei OWN wird der Cost auf den Product-Cost addiert; sichtbar
            hier als Audit-Trail. */}
        {productRepairs.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>REPAIR HISTORY</span>
              <div style={{ marginTop: 12 }}>
                {productRepairs.map(rep => {
                  const totalCost = computeRepairTotalCost(rep, sumOpenRepairLineCosts(rep.id));
                  const isOwn = rep.repairScope === 'OWN';
                  return (
                    <div key={rep.id}
                      onClick={() => navigate(`/repairs/${rep.id}`)}
                      className="cursor-pointer transition-colors"
                      style={{ padding: '12px 14px', borderBottom: '1px solid #E5E9EE', display: 'grid', gridTemplateColumns: '120px 1fr 100px 130px 110px', gap: 16, alignItems: 'center' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{rep.repairNumber}</span>
                      <div>
                        <div style={{ fontSize: 13, color: '#0F0F10' }}>{rep.issueDescription || 'Repair'}</div>
                        {rep.diagnosis && (
                          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{rep.diagnosis}</div>
                        )}
                      </div>
                      <span style={{
                        fontSize: 11, padding: '3px 8px', borderRadius: 999, textAlign: 'center',
                        background: isOwn ? 'rgba(170,149,110,0.12)' : 'rgba(113,93,227,0.06)',
                        color: isOwn ? '#8A7548' : '#715DE3',
                        border: `1px solid ${isOwn ? 'rgba(170,149,110,0.4)' : 'rgba(113,93,227,0.3)'}`,
                      }}>{isOwn ? 'Own Item' : 'Customer'}</span>
                      <span style={{ fontSize: 12, color: '#6B7280' }}>
                        {rep.receivedAt ? new Date(rep.receivedAt).toLocaleDateString() : '—'}
                      </span>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right' }}>
                        {totalCost > 0 ? `${fmt(totalCost)} BHD` : '—'}
                      </span>
                    </div>
                  );
                })}
                {productRepairs.some(r => r.repairScope === 'OWN' && r.completedAt) && (
                  <div className="flex justify-between" style={{ padding: '12px 14px', marginTop: 4, fontSize: 12, color: '#6B7280' }}>
                    <span>Total Own-Item repair cost capitalized into purchase price</span>
                    <span className="font-mono" style={{ color: '#0F0F10' }}>
                      {fmt(productRepairs.filter(r => r.repairScope === 'OWN' && r.completedAt).reduce((s, r) => s + computeRepairTotalCost(r, sumOpenRepairLineCosts(r.id)), 0))} BHD
                    </span>
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Item" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete <strong style={{ color: '#0F0F10' }}>{product.brand} {product.name}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="products"
        entityId={product.id}
        title={`History · ${product.brand} ${product.name}`}
      />
    </div>
  );
}
