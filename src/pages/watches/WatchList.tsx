import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Trash2, X, Check, Link2, Tag } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SkuInput } from '@/components/ui/SkuInput';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { DuplicateWarningModal, type DuplicateMatch } from '@/components/ui/DuplicateWarningModal';
import { buildBatchTagsZpl } from '@/core/print/zpl-tag';
import { printRawZpl, canRawPrint, getTagPrinterName, setTagPrinterName } from '@/core/print/raw-print';
import { useProductStore } from '@/stores/productStore';
import { matchesDeep } from '@/core/utils/deep-search';
import { getStockAggregates, type LotAggregate } from '@/core/lots/lot-queries';
import { exportFile } from '@/core/utils/export-file';
import ExcelJS from 'exceljs';
import type { Product, TaxScheme, StockStatus, Category } from '@/core/models/types';
import type { AiCategoryId } from '@/core/ai/ai-service';
import { Bhd } from '@/components/ui/Bhd';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
      <span className="text-overline" style={{ color: '#6B7280', marginRight: 4 }}>{label}</span>
      {children}
    </div>
  );
}

// Echtes .xlsx via ExcelJS — Bilder werden als binary in xl/media/ eingebettet
// und von Excel nativ in der Zelle gerendert. Der frühere HTML-zu-.xls-Hack
// scheiterte daran, dass Excel <img src="data:..."> als verknüpftes externes Bild
// behandelt und mit "linked image cannot be displayed" verweigerte.
async function exportProductsToExcel(items: Product[], categories: Category[]) {
  const today = new Date().toISOString().split('T')[0];
  const cat = (id: string) => categories.find(c => c.id === id)?.name || '';
  // Phase 7 — Lot-Aggregat einmal vorab fuer alle exportierten Produkte ziehen,
  // damit Total-Row + per-row "Purchase Price" das echte Bestands-Mittel zeigen
  // (statt single product.purchase_price).
  const lotAgg = getStockAggregates(items.map(p => p.id));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'LATAIF';
  wb.created = new Date();
  const ws = wb.addWorksheet('Collection');

  ws.columns = [
    { header: 'Image',                    key: 'image',    width: 12 },
    { header: 'SKU',                      key: 'sku',      width: 14 },
    { header: 'Brand',                    key: 'brand',    width: 16 },
    { header: 'Name',                     key: 'name',     width: 26 },
    { header: 'Category',                 key: 'category', width: 14 },
    { header: 'Quantity',                 key: 'qty',      width: 9,  style: { numFmt: '#,##0' } },
    { header: 'Condition',                key: 'cond',     width: 12 },
    { header: 'Purchase Price (BHD)',     key: 'pp',       width: 16, style: { numFmt: '#,##0.000' } },
    { header: 'Cost Range (BHD)',         key: 'ppRange',  width: 18 },
    { header: 'Stock Value (BHD)',        key: 'stockVal', width: 16, style: { numFmt: '#,##0.000' } },
    { header: 'Lots',                     key: 'lots',     width: 8,  style: { numFmt: '#,##0' } },
    { header: 'Planned Sale Price (BHD)', key: 'spp',      width: 18, style: { numFmt: '#,##0.000' } },
    { header: 'Min Sale (BHD)',           key: 'min',      width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Max Sale (BHD)',           key: 'max',      width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Expected Margin (BHD)',    key: 'margin',   width: 16, style: { numFmt: '#,##0.000' } },
    { header: 'Tax Scheme',               key: 'tax',      width: 14 },
    { header: 'Stock Status',             key: 'status',   width: 14 },
    { header: 'Source Type',              key: 'source',   width: 12 },
    { header: 'Storage Location',         key: 'storage',  width: 16 },
    { header: 'Supplier',                 key: 'supplier', width: 16 },
    { header: 'Purchase Source',          key: 'psource',  width: 16 },
    { header: 'Paid From',                key: 'paid',     width: 10 },
    { header: 'Purchase Date',            key: 'pdate',    width: 14 },
    { header: 'Days in Stock',            key: 'days',     width: 10 },
    { header: 'Notes',                    key: 'notes',    width: 26 },
  ];

  // Header-Row Styling.
  const header = ws.getRow(1);
  header.font = { bold: true, size: 11, color: { argb: 'FF0F0F10' } };
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.height = 22;
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F7FA' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFC6A36D' } } };
  });

  // Data-Rows + Image-Embedding.
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const a = lotAgg.get(p.id);
    const fmt3 = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const row = ws.addRow({
      image:    '', // Platzhalter — Bild wird via addImage über die Zelle gelegt.
      sku:      p.sku || '',
      brand:    p.brand,
      name:     p.name,
      category: cat(p.categoryId),
      qty:      a ? a.totalQty : (p.quantity || 1),
      cond:     p.condition || '',
      pp:       a ? a.weightedAvg : p.purchasePrice,
      ppRange:  a && a.lotCount > 1 ? `${fmt3(a.minCost)}–${fmt3(a.maxCost)}` : '',
      stockVal: a ? a.totalValue : p.purchasePrice * (p.quantity || 1),
      lots:     a ? a.lotCount : 1,
      spp:      p.plannedSalePrice ?? '',
      min:      p.minSalePrice ?? '',
      max:      p.maxSalePrice ?? '',
      margin:   p.expectedMargin ?? '',
      tax:      p.taxScheme === 'MARGIN' ? 'Margin Scheme' : p.taxScheme === 'VAT_10' ? 'VAT 10%' : 'Zero',
      status:   p.stockStatus,
      source:   p.sourceType,
      storage:  p.storageLocation || '',
      supplier: p.supplierName || '',
      psource:  p.purchaseSource || '',
      paid:     p.paidFrom || '',
      pdate:    p.purchaseDate || '',
      days:     p.daysInStock ?? '',
      notes:    p.notes || '',
    });
    row.height = 60; // ~80 px — passt zu 75x75 Bild.
    row.alignment = { vertical: 'middle' };

    // Erstes Bild aus images[] als data-URL einlesen, decodieren, einbetten.
    const src = p.images?.[0] || '';
    const m = src.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
    if (m) {
      const ext = m[1].toLowerCase().startsWith('jp') ? 'jpeg' : 'png';
      try {
        const bin = atob(m[2]);
        const buf = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) buf[j] = bin.charCodeAt(j);
        const imgId = wb.addImage({ buffer: buf as unknown as ArrayBuffer, extension: ext });
        // tl/br positioning: Spalte 0 = Image, Datenzeile = i+1 (Header ist row 0).
        // Wir setzen tl + ext (size in pixel) statt br, damit die Zelle nicht streckt.
        ws.addImage(imgId, {
          tl: { col: 0.1, row: i + 1.1 },
          ext: { width: 70, height: 70 },
          editAs: 'oneCell',
        });
      } catch (err) {
        console.warn('[Excel-Export] image decode failed for', p.id, err);
      }
    }
  }

  // Totals-Row (nur OWN, in_stock). Stock Value kommt aus stock_lots wenn vorhanden.
  const ownInStock = items.filter(p =>
    (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
  );
  let totalQty = 0, totalEK = 0;
  for (const p of ownInStock) {
    const a = lotAgg.get(p.id);
    if (a) { totalQty += a.totalQty; totalEK += a.totalValue; }
    else   { totalQty += p.quantity || 1; totalEK += p.purchasePrice * (p.quantity || 1); }
  }
  const totalVK = ownInStock.reduce((s, p) => s + (p.plannedSalePrice || 0) * (p.quantity || 1), 0);

  const totalRow = ws.addRow({
    image: '', sku: '', brand: '', name: 'TOTAL (OWN · In Stock)', category: '',
    qty: totalQty, cond: '', pp: '', ppRange: '', stockVal: totalEK, lots: '', spp: totalVK,
  });
  totalRow.height = 22;
  totalRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F0F10' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  // Kopfzeile fixieren beim Scrollen.
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  await exportFile(
    `LATAIF_Collection_${today}.xlsx`,
    new Uint8Array(buffer),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

// Per-card price toggle: each product card holds its own Cost/Asking state.
// Phase 7: bei Multi-Lot zeigt die Cost-Ansicht den Total-Wert mit Range-Untertitel,
// statt nur den single product.purchase_price (irrefuehrend bei Qty 2 / 2 Preisen).
function CardPrice({ product, lot }: { product: Product; lot?: LotAggregate }) {
  const [mode, setMode] = useState<'cost' | 'asking'>('cost');
  const multiLot = lot && lot.lotCount > 1;
  let mainValue: number;
  if (mode === 'asking') {
    mainValue = product.plannedSalePrice || product.purchasePrice;
  } else if (lot) {
    mainValue = multiLot ? lot.totalValue : lot.weightedAvg;
  } else {
    mainValue = product.purchasePrice;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <span className="font-display" style={{ fontSize: 18, color: '#0F0F10' }}><Bhd v={mainValue}/></span>
        <span style={{ fontSize: 10, color: '#6B7280' }}>BHD{mode === 'cost' && multiLot ? ' · total' : ''}</span>
        <div className="flex" onClick={(e) => { e.stopPropagation(); }}
          style={{ border: '1px solid #E5E9EE', borderRadius: 999, padding: 1 }}>
          {(['cost', 'asking'] as const).map(m => (
            <button key={m} onClick={(e) => { e.stopPropagation(); setMode(m); }}
              className="cursor-pointer transition-all"
              style={{
                padding: '2px 8px', borderRadius: 999, fontSize: 9, border: 'none',
                background: mode === m ? '#0F0F10' : 'transparent',
                color: mode === m ? '#FFFFFF' : '#6B7280',
                textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500,
              }}>
              {m === 'cost' ? 'Cost' : 'Asking'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'cost' && multiLot && (
        <span style={{ fontSize: 10, color: '#AA956E' }}>
          {lot!.lotCount} Lots · <Bhd v={lot!.minCost}/>–<Bhd v={lot!.maxCost}/> BHD
        </span>
      )}
    </div>
  );
}

export function WatchList() {
  const navigate = useNavigate();
  const {
    products, categories, loadProducts, loadCategories, createProduct,
    searchQuery, setSearchQuery, filterCategory, setFilterCategory,
    filterStatus, setFilterStatus, getStockValue, nextAvailableSku,
    isSkuTaken, findPossibleDuplicates, getProductLinks, deleteProducts,
  } = useProductStore();
  const [showNew, setShowNew] = useState(false);
  const [selectedCat, setSelectedCat] = useState<Category | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // 2026-05-16 — Ownership-Filter: Default 'own' (eigene Ware), zusaetzlich
  // 'consignment' (nur Kommissionsware) und 'all' (alles). Filtert ueber
  // product.sourceType, damit auch bereits verkaufte Consignment-Items
  // korrekt zugeordnet bleiben.
  const [filterOwnership, setFilterOwnership] = useState<'own' | 'consignment' | 'all'>('own');
  const [form, setForm] = useState<Partial<Product>>({
    condition: '', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
  });
  // Duplicate Detection — Matches werden gefüllt, wenn handleCreate ein
  // mögliches Duplikat erkennt; User entscheidet "Cancel" oder "Create anyway".
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);
  // Live-Duplicate-Check beim Tippen — Debounce 800ms. Refs verhindern
  // Wiederöffnen für dieselbe Eingabe nach Cancel.
  const lastCheckedFp = useRef('');
  const lastDismissedFp = useRef('');

  // ── Multi-Select + Delete (v0.7.20) ──
  // selectMode aktiviert Checkboxen auf den Karten. linksMap haelt pro Produkt
  // die Verknuepfungen (leeres Array = loeschbar); verknuepfte Produkte sind
  // nicht selektierbar und zeigen ein Link-Badge. confirmDelete oeffnet den
  // Bestaetigungs-Dialog. deleteResult zeigt das Ergebnis nach dem Loeschen.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [linksMap, setLinksMap] = useState<Map<string, { label: string; count: number }[]>>(new Map());
  const [confirmDelete, setConfirmDelete] = useState(false);
  // v0.7.28 — ZPL-Tag-Druck: eigener Auswahl-Modus (alle Produkte wählbar, KEINE
  // Link-Sperre wie beim Löschen). Markierte Produkte → Batch-Druck (gerade Anzahl).
  const [printMode, setPrintMode] = useState(false);
  const [printSelectedIds, setPrintSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkPrint, setShowBulkPrint] = useState(false);
  const [bulkPrinter, setBulkPrinter] = useState(getTagPrinterName());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  useEffect(() => { loadCategories(); loadProducts(); }, [loadCategories, loadProducts]);

  // Beim Aktivieren des Select-Modus: Verknuepfungen aller Produkte laden, damit
  // wir linked vs. loeschbar pro Karte anzeigen koennen. Beim Verlassen: Reset.
  useEffect(() => {
    if (selectMode) {
      setLinksMap(getProductLinks());
    } else {
      setSelectedIds(new Set());
      setLinksMap(new Map());
    }
  }, [selectMode, products, getProductLinks]);

  const isLinked = (id: string) => (linksMap.get(id)?.length ?? 0) > 0;
  const toggleSelect = (id: string) => {
    if (isLinked(id)) return; // verknuepfte Produkte koennen nicht selektiert werden
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // Druck-Auswahl: KEINE Link-Sperre — jedes Produkt darf ein Tag bekommen.
  const togglePrintSelect = (id: string) => {
    setPrintSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  function performDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) { setConfirmDelete(false); return; }
    const { deleted, blocked } = deleteProducts(ids);
    setConfirmDelete(false);
    setSelectMode(false);
    setSelectedIds(new Set());
    // blocked sollte leer sein (linked Items sind nicht selektierbar) — aber als
    // Sicherheitsnetz melden falls sich zwischen Auswahl und Loeschen was aenderte.
    if (blocked.length > 0) {
      alert(`${deleted.length} item(s) deleted.\n${blocked.length} skipped — they are linked to records and cannot be deleted.`);
    }
  }

  // Live Duplicate Detection — sobald Brand/Name/SKU/Ref/Serial sich
  // stabilisieren (800ms ohne Eingabe), öffnet das Side-by-Side automatisch.
  // Reset wenn das Modal gar nicht offen ist (showNew = false).
  const attrs = form.attributes || {};
  const fp = [
    form.brand, form.name, form.sku,
    attrs.reference_number, attrs.serial_number,
    attrs.weight, attrs.karat, attrs.item_type,
  ].map(v => String(v ?? '').trim().toUpperCase()).join('|');
  useEffect(() => {
    if (!showNew) { lastCheckedFp.current = ''; lastDismissedFp.current = ''; return; }
    if (duplicateMatches.length > 0) return;
    if (!form.brand?.trim() && !form.name?.trim() && !form.sku?.trim()) return;
    if (fp === lastCheckedFp.current) return;
    if (fp === lastDismissedFp.current) return;
    const t = setTimeout(() => {
      lastCheckedFp.current = fp;
      const possible = findPossibleDuplicates(form);
      if (possible.length > 0) setDuplicateMatches(possible);
    }, 800);
    return () => clearTimeout(t);
  }, [fp, showNew, duplicateMatches.length, form, findPossibleDuplicates]);

  const filtered = useMemo(() => {
    // Interne Service-Produkte (Repair Service) sind immer ausgeblendet.
    // Service-Produkte haben categoryId='cat-repair-service-*'.
    let r = products.filter(p => !(p.categoryId || '').startsWith('cat-repair-service'));
    // Ownership-Filter (Plan §Commission §5): trennt eigene Ware (OWN) von
    // Kommissionsware (CONSIGNMENT). 'all' zeigt beides zusammen.
    if (filterOwnership === 'own') {
      r = r.filter(p => p.sourceType !== 'CONSIGNMENT');
    } else if (filterOwnership === 'consignment') {
      r = r.filter(p => p.sourceType === 'CONSIGNMENT');
    }
    if (searchQuery) {
      r = r.filter(p => matchesDeep(p, searchQuery, [categories.find(c => c.id === p.categoryId)]));
    }
    if (filterCategory) r = r.filter(p => p.categoryId === filterCategory);
    // Plan §Production-History (2026-05-18): Consumed-Items haben Sonderbehandlung.
    // - Default (filterStatus = ''): NICHT zeigen, damit Inventar nicht aufgeblaeht wirkt.
    // - Explizit (filterStatus = 'consumed'): NUR consumed zeigen.
    // - Anderer Status: normales Match.
    if (filterStatus === 'consumed' || filterStatus === 'CONSUMED') {
      r = r.filter(p => p.stockStatus === 'consumed' || p.stockStatus === 'CONSUMED');
    } else if (filterStatus) {
      r = r.filter(p => p.stockStatus === filterStatus);
    } else {
      r = r.filter(p => p.stockStatus !== 'consumed' && p.stockStatus !== 'CONSUMED');
    }
    return r;
  }, [products, searchQuery, filterCategory, filterStatus, filterOwnership, categories]);

  const stock = useMemo(() => getStockValue(), [products, getStockValue]);
  // Phase 7 — Lot-Aggregat einmal pro Render fuer alle sichtbaren Produkte.
  const lotAgg = useMemo(() => getStockAggregates(filtered.map(p => p.id)), [filtered]);
  const getCat = (id: string) => categories.find(c => c.id === id);

  function openNew(cat?: Category) {
    setSelectedCat(cat || categories[0] || null);
    setForm({
      categoryId: cat?.id || categories[0]?.id || '',
      condition: cat?.conditionOptions?.[0] || '', taxScheme: 'MARGIN',
      scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {},
    });
    setShowNew(true);
  }

  function validateForm(): Record<string, string> {
    // Strikte Validierung — alle mit `*` markierten Felder müssen ausgefüllt sein,
    // sonst muss der User später nochmal im Edit ran. Foto bleibt optional.
    const errs: Record<string, string> = {};
    if (!form.categoryId) errs.categoryId = 'Required';
    // v0.7.16 — Brand/Name nur bei branded-Kategorien Pflicht (analog NewProductModal
    // v0.6.8). Gold-Diamond Jewellery + Original Gold sind handgemacht ohne Brand.
    // v0.7.16 — unbranded: cat-gold-jewelry + cat-accessory.
    const brandedRequired = !(selectedCat?.id === 'cat-gold-jewelry' || selectedCat?.id === 'cat-accessory');
    if (brandedRequired) {
      if (!form.brand?.trim()) errs.brand = 'Required';
      if (!form.name?.trim()) errs.name = 'Required';
    }
    // Condition ist optional (2026-05-17) — kein Required-Check mehr.
    if (selectedCat) {
      for (const attr of selectedCat.attributes) {
        if (!attr.required) continue;
        // Conditional Attribute übersprungen, wenn Abhängigkeit nicht erfüllt.
        if (attr.dependsOn) {
          const dep = form.attributes?.[attr.dependsOn.key];
          if (!dep || !attr.dependsOn.valueIncludes.includes(String(dep))) continue;
        }
        const v = form.attributes?.[attr.key];
        const errKey = `attr_${attr.key}`;
        if (attr.type === 'number') {
          if (typeof v !== 'number' || isNaN(v) || v === 0) errs[errKey] = 'Required';
        } else if (attr.type === 'boolean') {
          if (v === undefined || v === null) errs[errKey] = 'Required';
        } else {
          if (!String(v ?? '').trim()) errs[errKey] = 'Required';
        }
      }
    }
    return errs;
  }

  function handleCreate() {
    // Strikte Validierung: alle Pflichtfelder müssen ausgefüllt sein.
    const errs = validateForm();
    if (form.sku && isSkuTaken(form.sku)) {
      errs.sku = 'Diese SKU / Reference ist bereits vergeben.';
    }
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      // Scroll zum ersten Fehler
      const first = Object.keys(errs)[0];
      const el = document.getElementById(`new-field-${first}`) || document.getElementById(`new-field-${first.replace(/^attr_/, 'attr_')}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // Score-basierte Duplicate Detection (nicht-blockierend): wenn ähnliche
    // Items im Bestand existieren, Modal zeigen — User kann trotzdem anlegen.
    const possible = findPossibleDuplicates(form);
    if (possible.length > 0) {
      setDuplicateMatches(possible);
      return;
    }
    createProduct(form);
    setErrors({});
    setShowNew(false);
  }

  function confirmCreateAnyway() {
    createProduct(form);
    setErrors({});
    setDuplicateMatches([]);
    setShowNew(false);
  }

  function updateAttr(key: string, value: string | number | boolean) {
    setForm({ ...form, attributes: { ...(form.attributes || {}), [key]: value } });
  }

  return (
    <PageLayout
      title="Collection"
      subtitle={
        filterOwnership === 'consignment'
          ? `${filtered.length} consignment item${filtered.length === 1 ? '' : 's'}`
          : filterOwnership === 'all'
            ? `${filtered.length} item${filtered.length === 1 ? '' : 's'} (own + consignment)`
            : `${stock.count} items in stock \u00b7 ${fmt(stock.purchaseTotal)} BHD`
      }
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search by brand, name, SKU..."
      actions={
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {printMode ? (
            <>
              <Button variant="ghost" onClick={() => { setPrintMode(false); setPrintSelectedIds(new Set()); }}>
                <X size={14} /> Cancel
              </Button>
              <Button variant="ghost" onClick={() => setPrintSelectedIds(prev =>
                prev.size === filtered.length ? new Set() : new Set(filtered.map(p => p.id))
              )}>
                {printSelectedIds.size === filtered.length && filtered.length > 0 ? 'Clear all' : 'Select all'}
              </Button>
              <Button variant="primary" disabled={printSelectedIds.size === 0}
                onClick={() => { setBulkError(null); setBulkPrinter(getTagPrinterName()); setShowBulkPrint(true); }}>
                <Tag size={14} /> Print Tags ({printSelectedIds.size})
              </Button>
            </>
          ) : selectMode ? (
            <>
              <Button variant="ghost" onClick={() => setSelectMode(false)}>
                <X size={14} /> Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => setConfirmDelete(true)}
                disabled={selectedIds.size === 0}
              >
                <Trash2 size={14} /> Delete ({selectedIds.size})
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={filtered.length === 0} onClick={() => { setPrintSelectedIds(new Set()); setPrintMode(true); }}>
                <Tag size={14} /> Print Tags
              </Button>
              <Button variant="ghost" onClick={() => exportProductsToExcel(filtered, categories)}>
                Export Excel ({filtered.length})
              </Button>
              <Button variant="ghost" onClick={() => navigate('/settings?tab=duplicates')}>
                Find Duplicates
              </Button>
              <Button variant="ghost" onClick={() => setSelectMode(true)}>
                <Trash2 size={14} /> Select
              </Button>
              <Button variant="secondary" onClick={() => navigate('/import')}>Import Excel</Button>
              <Button variant="primary" onClick={() => openNew()}>New Item</Button>
            </>
          )}
        </div>
      }
    >
      {/* Filter Bar — wraps cleanly on smaller screens. */}
      <div style={{
        background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12,
        padding: '14px 18px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
      }}>
        <FilterGroup label="Ownership">
          {(['own', 'consignment', 'all'] as const).map(o => (
            <button key={o} onClick={() => setFilterOwnership(o)}
              className="cursor-pointer transition-all duration-200"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 12,
                border: `1px solid ${filterOwnership === o ? '#0F0F10' : '#D5D9DE'}`,
                color: filterOwnership === o ? '#0F0F10' : '#6B7280',
                background: filterOwnership === o ? 'rgba(15,15,16,0.06)' : '#FFFFFF',
              }}>{o === 'own' ? 'Own' : o === 'consignment' ? 'Consignment' : 'All'}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="Category">
          <button onClick={() => setFilterCategory('')}
            className="cursor-pointer transition-all duration-200"
            style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 12,
              border: `1px solid ${!filterCategory ? '#0F0F10' : '#D5D9DE'}`,
              color: !filterCategory ? '#0F0F10' : '#6B7280',
              background: !filterCategory ? 'rgba(15,15,16,0.06)' : '#FFFFFF',
            }}>All</button>
          {categories.filter(c => !c.id.startsWith('cat-repair-service')).map(cat => (
            <button key={cat.id} onClick={() => setFilterCategory(cat.id)}
              className="cursor-pointer transition-all duration-200"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 12,
                border: `1px solid ${filterCategory === cat.id ? cat.color : '#D5D9DE'}`,
                color: filterCategory === cat.id ? cat.color : '#6B7280',
                background: filterCategory === cat.id ? cat.color + '15' : '#FFFFFF',
              }}>{cat.name}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="Status">
          {(['', 'in_stock', 'sold', 'consumed'] as (StockStatus | '')[]).map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className="cursor-pointer transition-all duration-200"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 12,
                border: `1px solid ${filterStatus === s ? '#0F0F10' : '#D5D9DE'}`,
                color: filterStatus === s ? '#0F0F10' : '#6B7280',
                background: filterStatus === s ? 'rgba(15,15,16,0.06)' : '#FFFFFF',
              }}>{s === '' ? 'Any' : s === 'in_stock' ? 'In Stock' : s === 'sold' ? 'Sold' : 'Consumed'}</button>
          ))}
        </FilterGroup>
        {(filterOwnership !== 'own' || filterCategory || filterStatus !== '') && (
          <button onClick={() => { setFilterOwnership('own'); setFilterCategory(''); setFilterStatus(''); }}
            className="cursor-pointer"
            style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 12,
              border: 'none', background: 'transparent',
              color: '#AA956E', marginLeft: 'auto',
            }}>Clear filters</button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <Package size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {searchQuery || filterCategory || filterStatus ? 'No items match your filters.' : 'Your collection is empty.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          {filtered.map(p => {
            const cat = getCat(p.categoryId);
            // Show some dynamic attributes in the card
            const showAttrs = cat?.attributes.filter(a => a.showInList) || [];
            const attrText = showAttrs
              .map(a => p.attributes[a.key])
              .filter(Boolean)
              .join(' \u00b7 ');

            // v0.7.20 — Select-Modus: Karte selektierbar (saubere Produkte) oder
            // als verknuepft markiert (nicht loeschbar). Klick toggelt Auswahl
            // statt zur Detailseite zu navigieren.
            const linked = isLinked(p.id);
            const selected = selectedIds.has(p.id);
            const pSelected = printSelectedIds.has(p.id);
            const links = linksMap.get(p.id) || [];
            const reason = Array.from(new Set(links.map(l => l.label))).slice(0, 3).join(' · ');

            return (
              <Card
                key={p.id}
                hoverable={printMode ? true : (!selectMode || !linked)}
                noPadding
                onClick={() => printMode ? togglePrintSelect(p.id) : selectMode ? toggleSelect(p.id) : navigate(`/collection/${p.id}`)}
                style={printMode ? {
                  border: pSelected ? '2px solid #0F0F10' : '1px solid #D5D9DE',
                  cursor: 'pointer',
                } : selectMode ? {
                  border: selected ? '2px solid #0F0F10' : linked ? '1px solid #E5E9EE' : '1px solid #D5D9DE',
                  opacity: linked ? 0.6 : 1,
                  cursor: linked ? 'not-allowed' : 'pointer',
                } : undefined}
              >
                <div className="flex items-center justify-center relative"
                  style={{ height: 180, background: '#F2F7FA', borderBottom: '1px solid #E5E9EE', overflow: 'hidden' }}>
                  {p.images.length > 0 ? (
                    // v0.7.17 — `contain` statt `cover`: User-Foto bleibt vollstaendig sichtbar
                    // (vorher schnitt `cover` Raender ab um die Karte zu fuellen).
                    <img src={p.images[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  ) : (
                    <Package size={36} strokeWidth={1} style={{ color: '#6B7280' }} />
                  )}
                  {/* v0.7.20 — Select-Modus Overlays: Checkbox (saubere) oder Link-Badge (verknuepft). */}
                  {printMode && (
                    <span className="absolute flex items-center justify-center" style={{
                      top: 12, left: 12, width: 24, height: 24, borderRadius: 999,
                      background: pSelected ? '#0F0F10' : '#FFFFFF',
                      border: `1.5px solid ${pSelected ? '#0F0F10' : '#D5D9DE'}`,
                      zIndex: 2,
                    }}>
                      {pSelected && <Check size={14} style={{ color: '#FFFFFF' }} strokeWidth={3} />}
                    </span>
                  )}
                  {selectMode && (
                    linked ? (
                      <span className="absolute flex items-center gap-1" style={{
                        top: 12, left: 12, fontSize: 10, padding: '3px 8px', borderRadius: 999,
                        background: '#FFFFFF', color: '#6B7280', border: '1px solid #D5D9DE',
                        zIndex: 2,
                      }} title={`Linked to: ${reason} — cannot be deleted`}>
                        <Link2 size={11} /> Linked
                      </span>
                    ) : (
                      <span className="absolute flex items-center justify-center" style={{
                        top: 12, left: 12, width: 24, height: 24, borderRadius: 999,
                        background: selected ? '#0F0F10' : '#FFFFFF',
                        border: `1.5px solid ${selected ? '#0F0F10' : '#D5D9DE'}`,
                        zIndex: 2,
                      }}>
                        {selected && <Check size={14} style={{ color: '#FFFFFF' }} strokeWidth={3} />}
                      </span>
                    )
                  )}
                  {/* v0.7.20 — im Select-Modus gehoert die obere linke Ecke der
                      Checkbox/Linked-Badge; Kategorie-Chip rutscht dann eine Zeile
                      tiefer (top 44 statt 12), damit er sichtbar bleibt aber die
                      (breitere) "Linked"-Badge nicht ueberlappt. */}
                  {cat && (
                    <span className="absolute" style={{
                      top: (selectMode || printMode) ? 44 : 12, left: 12, fontSize: 10, padding: '2px 10px', borderRadius: 999,
                      background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                    }}>{cat.name}</span>
                  )}
                  <span className="absolute" style={{
                    top: 12, right: 12, fontSize: 10, color: '#6B7280',
                    border: '1px solid #D5D9DE', padding: '2px 8px', borderRadius: 999,
                  }}>{p.taxScheme === 'MARGIN' ? 'Margin' : p.taxScheme === 'VAT_10' ? 'Standard VAT' : 'Exempt'}</span>
                </div>
                <div style={{ padding: '18px 22px 22px' }}>
                  <span className="text-overline">{p.brand}</span>
                  <h3 className="font-display" style={{ fontSize: 18, color: '#0F0F10', marginTop: 4, lineHeight: 1.25 }}>{p.name}</h3>
                  {p.sku && <span className="font-mono" style={{ fontSize: 11, color: '#4B5563', display: 'block', marginTop: 3 }}>{p.sku}</span>}
                  {attrText && <span style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 4 }}>{attrText}</span>}
                  <div className="flex items-center justify-between" style={{ marginTop: 16, gap: 8 }}>
                    <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                      <CardPrice product={p} lot={lotAgg.get(p.id)} />
                      {(() => {
                        // Phase 7: Stueck-Badge zeigt Lot-Total (echte verfuegbare Stuecke)
                        // statt product.quantity (Legacy-Feld, oft nicht synchron).
                        const qty = lotAgg.get(p.id)?.totalQty ?? (p.quantity || 1);
                        if (qty <= 1) return null;
                        return (
                          <span className="font-mono" style={{
                            fontSize: 11, color: '#AA956E',
                            padding: '2px 8px', border: '1px solid rgba(170,149,110,0.4)',
                            borderRadius: 999,
                          }}>x {qty}</span>
                        );
                      })()}
                    </div>
                    <StatusDot status={p.stockStatus} />
                  </div>
                  {p.expectedMargin !== undefined && p.expectedMargin > 0 && (
                    <div className="flex items-center justify-between" style={{ marginTop: 8, fontSize: 12 }}>
                      <span style={{ color: '#6B7280' }}>Margin</span>
                      <span className="font-mono" style={{ color: '#7EAA6E' }}><Bhd v={p.expectedMargin}/> BHD</span>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* New Product Modal */}
      <Modal open={showNew} onClose={() => { setShowNew(false); setErrors({}); }} title="New Item" width={660}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>

          {/* Required-fields hint */}
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: '#F2F7FA', border: '1px solid #E5E9EE',
            color: '#6B7280', fontSize: 12, lineHeight: 1.5,
          }}>
            Fields marked with <span style={{ color: '#DC2626' }}>*</span> are required. Add a photo and click <strong style={{ color: '#0F0F10' }}>AI Identify</strong> to auto-fill most fields.
          </div>

          {/* Category Selector */}
          <div id="new-field-categoryId" style={{ padding: errors.categoryId ? 8 : 0, border: errors.categoryId ? '1px solid #DC2626' : 'none', borderRadius: 8 }}>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
              CATEGORY
              <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
            </span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {categories.filter(c => !c.id.startsWith('cat-repair-service')).map(cat => (
                <button key={cat.id}
                  onClick={() => {
                    setSelectedCat(cat);
                    setForm({ ...form, categoryId: cat.id, condition: cat.conditionOptions?.[0] || '', attributes: {} });
                    if (errors.categoryId) setErrors({ ...errors, categoryId: '' });
                  }}
                  className="cursor-pointer rounded-lg transition-all duration-200"
                  style={{
                    padding: '10px 18px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${form.categoryId === cat.id ? cat.color : '#D5D9DE'}`,
                    color: form.categoryId === cat.id ? cat.color : '#6B7280',
                    background: form.categoryId === cat.id ? cat.color + '08' : 'transparent',
                  }}>
                  <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Universal Fields — v0.7.16: branded-Pflicht analog NewProductModal */}
          {(() => {
            // v0.7.16 — unbranded: cat-gold-jewelry + cat-accessory.
    const brandedRequired = !(selectedCat?.id === 'cat-gold-jewelry' || selectedCat?.id === 'cat-accessory');
            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div id="new-field-brand">
                  <Input required={brandedRequired}
                    label={brandedRequired ? 'BRAND' : 'BRAND (OPTIONAL)'}
                    placeholder={brandedRequired ? 'e.g. Rolex, Hermes, Cartier' : 'leer = unbranded'}
                    value={form.brand || ''} error={errors.brand}
                    onChange={e => { setForm({ ...form, brand: e.target.value }); if (errors.brand) setErrors({ ...errors, brand: '' }); }} />
                </div>
                <div id="new-field-name">
                  <Input required={brandedRequired}
                    label={brandedRequired ? 'NAME / MODEL' : 'NAME / MODEL (OPTIONAL)'}
                    placeholder={brandedRequired ? 'e.g. Submariner, Birkin 30' : 'leer = Beleg nimmt Beschreibung'}
                    value={form.name || ''} error={errors.name}
                    onChange={e => { setForm({ ...form, name: e.target.value }); if (errors.name) setErrors({ ...errors, name: '' }); }} />
                </div>
              </div>
            );
          })()}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
            <SkuInput value={form.sku || ''} onChange={v => setForm({ ...form, sku: v })} />
            <Input label="QUANTITY" type="number" placeholder="1" value={form.quantity || 1}
              onChange={e => setForm({ ...form, quantity: Math.max(1, Number(e.target.value) || 1) })} />
          </div>

          {/* Dynamic Attributes from Category */}
          {selectedCat && selectedCat.attributes.length > 0 && (
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              <span className="text-overline" style={{ marginBottom: 12 }}>{selectedCat.name.toUpperCase()} DETAILS</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
                {selectedCat.attributes.map(attr => {
                  // Conditional Visibility (dependsOn): nur rendern, wenn die
                  // Abhängigkeit erfüllt ist. Erlaubt z.B. Karat-Feld nur bei Gold-Material.
                  if (attr.dependsOn) {
                    const dep = form.attributes?.[attr.dependsOn.key];
                    if (!dep || !attr.dependsOn.valueIncludes.includes(String(dep))) return null;
                  }
                  const errKey = `attr_${attr.key}`;
                  const hasErr = !!errors[errKey];
                  // Selects mit vielen Chips (≥8) bekommen volle Grid-Breite,
                  // damit die Höhenungleichheit nicht zu Gaps in der Nachbar-Spalte führt.
                  const isWide = attr.type === 'select' && (attr.options?.length || 0) >= 8;
                  if (attr.type === 'select' && attr.options) {
                    return (
                      <div key={attr.key} id={`new-field-${errKey}`} style={{ padding: hasErr ? 8 : 0, border: hasErr ? '1px solid #DC2626' : 'none', borderRadius: 8, gridColumn: isWide ? '1 / -1' : 'auto' }}>
                        <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                          {attr.label.toUpperCase()}
                          {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                        </span>
                        <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                          {attr.options.map(opt => (
                            <button key={opt} onClick={() => { updateAttr(attr.key, opt); if (hasErr) setErrors({ ...errors, [errKey]: '' }); }}
                              className="cursor-pointer transition-all duration-200"
                              style={{
                                padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                border: `1px solid ${form.attributes?.[attr.key] === opt ? '#0F0F10' : '#D5D9DE'}`,
                                color: form.attributes?.[attr.key] === opt ? '#0F0F10' : '#6B7280',
                                background: form.attributes?.[attr.key] === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                              }}>{opt}</button>
                          ))}
                        </div>
                        {hasErr && <span style={{ fontSize: 12, color: '#DC2626', display: 'block', marginTop: 4 }}>{errors[errKey]}</span>}
                      </div>
                    );
                  }
                  // v0.7.14 — Boolean → Yes/No-Toggle.
                  if (attr.type === 'boolean') {
                    const val = form.attributes?.[attr.key];
                    return (
                      <div key={attr.key} id={`new-field-${errKey}`} style={{ padding: hasErr ? 8 : 0, border: hasErr ? '1px solid #DC2626' : 'none', borderRadius: 8 }}>
                        <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                          {attr.label.toUpperCase()}
                          {attr.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                        </span>
                        <div className="flex gap-2" style={{ marginTop: 6 }}>
                          {[true, false].map(opt => (
                            <button key={String(opt)} type="button" onClick={() => { updateAttr(attr.key, opt); if (hasErr) setErrors({ ...errors, [errKey]: '' }); }}
                              className="cursor-pointer rounded"
                              style={{
                                padding: '4px 14px', fontSize: 11, borderRadius: 999,
                                border: `1px solid ${val === opt ? '#0F0F10' : '#D5D9DE'}`,
                                color: val === opt ? '#0F0F10' : '#6B7280',
                                background: val === opt ? 'rgba(15,15,16,0.06)' : 'transparent',
                              }}>{opt ? 'Yes' : 'No'}</button>
                          ))}
                        </div>
                        {hasErr && <span style={{ fontSize: 12, color: '#DC2626', display: 'block', marginTop: 4 }}>{errors[errKey]}</span>}
                      </div>
                    );
                  }
                  return (
                    <div key={attr.key} id={`new-field-${errKey}`}>
                      <Input
                        required={attr.required}
                        label={attr.label.toUpperCase() + (attr.unit ? ` (${attr.unit})` : '')}
                        type={attr.type === 'number' ? 'number' : 'text'}
                        placeholder={attr.label}
                        value={(form.attributes?.[attr.key] as string) || ''}
                        error={errors[errKey]}
                        onChange={e => { updateAttr(attr.key, attr.type === 'number' ? Number(e.target.value) : e.target.value); if (hasErr) setErrors({ ...errors, [errKey]: '' }); }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Condition — optional (2026-05-17). */}
          {selectedCat && selectedCat.conditionOptions.length > 0 && (
            <div id="new-field-condition">
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
                CONDITION
              </span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {selectedCat.conditionOptions.map(cond => (
                  <button key={cond} onClick={() => { setForm({ ...form, condition: cond }); if (errors.condition) setErrors({ ...errors, condition: '' }); }}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${form.condition === cond ? '#0F0F10' : '#D5D9DE'}`,
                      color: form.condition === cond ? '#0F0F10' : '#6B7280',
                      background: form.condition === cond ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{cond}</button>
                ))}
              </div>
              {errors.condition && <span style={{ fontSize: 12, color: '#DC2626', display: 'block', marginTop: 4 }}>{errors.condition}</span>}
            </div>
          )}

          {/* Scope */}
          {selectedCat && selectedCat.scopeOptions.length > 0 && (
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>INCLUDED</span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {selectedCat.scopeOptions.map(item => {
                  const sel = (form.scopeOfDelivery || []).includes(item);
                  return (
                    <button key={item}
                      onClick={() => {
                        const s = form.scopeOfDelivery || [];
                        setForm({ ...form, scopeOfDelivery: sel ? s.filter(x => x !== item) : [...s, item] });
                      }}
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

          {/* Plan §Product §4: AI-Identify füllt alle Kategorie-Felder für ALLE Kategorien aus. */}
          {form.categoryId && (
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                <div>
                  <span className="text-overline">AI IDENTIFY &amp; RESEARCH</span>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                    Fills brand, name, all category attributes, condition, market value, description — you can still edit anything after.
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
                    if (!form.categoryId) { alert('Select a category first'); return; }
                    const hasImage = (form.images || []).length > 0;
                    const hasHints = !!form.brand || !!form.name || !!form.sku;
                    if (!hasImage && !hasHints) {
                      alert('Add a photo OR type a brand/name/reference hint first, then click AI Identify.');
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
                        // Kategorie-Attribute — Merge, Skalare/Booleans direkt übernehmen
                        const attrs = { ...(f.attributes || {}) };
                        for (const [k, v] of Object.entries(result.attributes || {})) {
                          if (v === null || v === undefined || v === '') continue;
                          attrs[k] = v as string | number | boolean | string[];
                        }
                        updated.attributes = attrs;
                        return updated;
                      });
                      // Sofortige Duplicate-Detection mit den frisch extrahierten
                      // Feldern — User sieht direkt nach AI-Identify, ob das Item
                      // schon im Bestand ist (Bild + Details Seite an Seite).
                      // setForm ist async; wir bauen den Kandidaten manuell aus result.
                      const candidate: Partial<Product> = {
                        categoryId: form.categoryId,
                        brand: result.brand || form.brand,
                        name: result.name || form.name,
                        sku: form.sku || (result.sku ? nextAvailableSku(result.sku) : undefined),
                        attributes: { ...(form.attributes || {}), ...(result.attributes || {}) } as Product['attributes'],
                        images: form.images,
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

          {/* Images */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span className="text-overline">PHOTOS</span>
              <span style={{ fontSize: 11, color: '#6B7280' }}>Add at least one photo for best AI results</span>
            </div>
            <div style={{ marginTop: 0 }}>
              <ImageUpload images={form.images || []} onChange={imgs => setForm({ ...form, images: imgs })} maxImages={6} />
            </div>
          </div>

          {/* Pricing */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 12 }}>PRICING</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
              <div id="new-field-purchasePrice">
                <Input required label="PURCHASE PRICE (BHD)" type="number" placeholder="0" value={form.purchasePrice || ''} error={errors.purchasePrice}
                  onChange={e => { setForm({ ...form, purchasePrice: Number(e.target.value) || 0 }); if (errors.purchasePrice) setErrors({ ...errors, purchasePrice: '' }); }} />
              </div>
              <Input label="SALE PRICE (BHD)" type="number" placeholder="Listing / target price" value={form.plannedSalePrice || ''} onChange={e => setForm({ ...form, plannedSalePrice: Number(e.target.value) || undefined })} />
              <Input label="MIN SALE PRICE (BHD)" type="number" placeholder="Negotiation floor" value={form.minSalePrice || ''} onChange={e => setForm({ ...form, minSalePrice: Number(e.target.value) || undefined })} />
            </div>
            {form.purchasePrice && form.plannedSalePrice && (
              <div className="rounded font-mono" style={{
                marginTop: 12, padding: 12, background: '#F2F7FA', border: '1px solid #E5E9EE',
                fontSize: 13, display: 'flex', justifyContent: 'space-between',
              }}>
                <span style={{ color: '#6B7280' }}>Expected Margin</span>
                <span style={{ color: (form.plannedSalePrice - form.purchasePrice) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                  <Bhd v={form.plannedSalePrice - form.purchasePrice}/> BHD ({((form.plannedSalePrice - form.purchasePrice) / form.purchasePrice * 100).toFixed(1)}%)
                </span>
              </div>
            )}
          </div>

          {/* Tax Scheme */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>TAX SCHEME</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {(['MARGIN', 'VAT_10', 'ZERO'] as TaxScheme[]).map(scheme => (
                <button key={scheme} onClick={() => setForm({ ...form, taxScheme: scheme })}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${form.taxScheme === scheme ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.taxScheme === scheme ? '#0F0F10' : '#6B7280',
                    background: form.taxScheme === scheme ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{scheme === 'MARGIN' ? 'Margin' : scheme === 'VAT_10' ? 'VAT 10%' : 'Zero'}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="STORAGE LOCATION" placeholder="Safe, Shelf, Display..." value={form.storageLocation || ''} onChange={e => setForm({ ...form, storageLocation: e.target.value })} />
            <Input label="SUPPLIER" placeholder="Supplier name" value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="PURCHASE SOURCE" placeholder="Souq, Private seller, Auction..." value={form.purchaseSource || ''} onChange={e => setForm({ ...form, purchaseSource: e.target.value })} />
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>PAID FROM</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
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
          </div>
          {form.paidFrom && form.purchasePrice ? (
            <div className="rounded font-mono" style={{
              padding: 12, background: '#F2F7FA', border: '1px solid #E5E9EE',
              fontSize: 12, color: '#6B7280', display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Will deduct from {form.paidFrom === 'cash' ? 'Cash' : 'Bank'}</span>
              <span style={{ color: '#AA6E6E' }}>− <Bhd v={form.purchasePrice}/> BHD</span>
            </div>
          ) : null}

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}>Add to Collection</Button>
          </div>
        </div>
      </Modal>

      <DuplicateWarningModal
        open={duplicateMatches.length > 0}
        matches={duplicateMatches}
        candidate={form}
        onCancel={() => { lastDismissedFp.current = fp; setDuplicateMatches([]); }}
        onCreateAnyway={confirmCreateAnyway}
        onPickExisting={(id) => { setDuplicateMatches([]); setShowNew(false); navigate(`/collection/${id}`); }}
        onCopyDetails={(id) => {
          const src = products.find(p => p.id === id);
          if (!src) return;
          // Stamm-Daten übernehmen — SKU/Serial/Purchase bleiben leer,
          // weil das physisch ein anderes Stück ist. Bild nur kopieren, wenn
          // der User noch keins selbst hochgeladen hat (Quick-Capture-Pfad).
          const srcAttrs = { ...(src.attributes || {}) } as Record<string, unknown>;
          delete srcAttrs.serial_number; delete srcAttrs.serialNo;
          setForm(f => ({
            ...f,
            brand: src.brand,
            name: src.name,
            categoryId: src.categoryId,
            condition: src.condition,
            taxScheme: src.taxScheme,
            plannedSalePrice: src.plannedSalePrice,
            minSalePrice: src.minSalePrice,
            maxSalePrice: src.maxSalePrice,
            storageLocation: src.storageLocation,
            scopeOfDelivery: [...(src.scopeOfDelivery || [])],
            notes: src.notes,
            images: (f.images && f.images.length > 0) ? f.images : [...(src.images || [])],
            attributes: { ...(f.attributes || {}), ...srcAttrs } as typeof f.attributes,
          }));
          setSelectedCat(categories.find(c => c.id === src.categoryId) || null);
          lastDismissedFp.current = fp;
          setDuplicateMatches([]);
        }}
      />

      {/* v0.7.20 — Bestaetigung Bulk-Delete. Listet die ausgewaehlten (sauberen)
          Produkte; nur diese werden geloescht. Verknuepfte sind gar nicht erst
          selektierbar. */}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete items?" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{
            padding: '10px 14px', borderRadius: 8,
            background: '#FDF2F2', border: '1px solid #F5D5D5',
            color: '#AA6E6E', fontSize: 13, lineHeight: 1.5,
          }}>
            You are about to permanently delete <strong>{selectedIds.size}</strong> item{selectedIds.size === 1 ? '' : 's'}.
            This <strong>cannot be undone</strong>. Only items with no links (not used in any
            invoice, purchase, consignment, production, etc.) can be deleted.
          </div>
          <div style={{ maxHeight: '40vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Array.from(selectedIds).map(id => {
              const p = products.find(x => x.id === id);
              if (!p) return null;
              return (
                <div key={id} className="flex items-center gap-3" style={{
                  padding: '8px 10px', borderRadius: 8, background: '#F2F7FA', border: '1px solid #E5E9EE',
                }}>
                  <div style={{ width: 36, height: 36, borderRadius: 6, overflow: 'hidden', background: '#FFFFFF', border: '1px solid #E5E9EE', flexShrink: 0 }}
                    className="flex items-center justify-center">
                    {p.images.length > 0
                      ? <img src={p.images[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      : <Package size={16} strokeWidth={1.2} style={{ color: '#9CA3AF' }} />}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {`${p.brand || ''} ${p.name || ''}`.trim() || '(unnamed)'}
                    </div>
                    {p.sku && <div className="font-mono" style={{ fontSize: 11, color: '#6B7280' }}>{p.sku}</div>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="primary" onClick={performDelete}>
              <Trash2 size={14} /> Delete {selectedIds.size} item{selectedIds.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* v0.7.27 — ZPL-Bulk-Tag-Druck (gerade Anzahl, 2 Tags pro Vorschub) */}
      <Modal open={showBulkPrint} onClose={() => setShowBulkPrint(false)} title="Print Tags (Zebra ZPL)" width={440}>
        {(() => {
          const selProducts = filtered.filter(p => printSelectedIds.has(p.id));
          const productCount = selProducts.length;
          const tagCount = productCount % 2 === 1 ? productCount + 1 : productCount;
          return (
            <>
              {!canRawPrint() && (
                <div style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 16, background: '#FFF7ED', border: '1px solid #FED7AA', color: '#9A6B3F', fontSize: 12.5, lineHeight: 1.5 }}>
                  Raw printing only works in the <strong>desktop app</strong>, not the browser preview.
                </div>
              )}
              <div style={{ padding: '12px 14px', borderRadius: 8, marginBottom: 16, background: '#F9FAFB', border: '1px solid #E5E7EB', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
                <div><strong style={{ color: '#0F0F10' }}>{productCount}</strong> product{productCount === 1 ? '' : 's'} selected.</div>
                <div>Prints <strong style={{ color: '#0F0F10' }}>{tagCount}</strong> tag{tagCount === 1 ? '' : 's'} (1 per product){tagCount !== productCount ? ' — rounded up to an even number (+1 spare of the last item) so no label is wasted' : ''}.</div>
                <div style={{ marginTop: 6, fontSize: 12, color: '#6B7280' }}>2 tags share one feed strip, so the total is always even.</div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 11, color: '#6B7280', display: 'block', marginBottom: 4 }}>PRINTER</label>
                <Input value={bulkPrinter} onChange={e => setBulkPrinter(e.target.value)} placeholder="Zebra ZD220 (203 dpi) - ZPL" />
              </div>
              {bulkError && (
                <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 14, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', fontSize: 12.5 }}>{bulkError}</div>
              )}
              <div className="flex justify-end gap-3">
                <Button variant="ghost" onClick={() => setShowBulkPrint(false)}>Cancel</Button>
                <Button variant="primary" disabled={bulkBusy || productCount === 0} onClick={async () => {
                  setBulkBusy(true); setBulkError(null);
                  try {
                    setTagPrinterName(bulkPrinter);
                    const items = selProducts.map(p => ({ product: p, category: getCat(p.categoryId) }));
                    if (items.length === 0) throw new Error('No products selected.');
                    if (items.length % 2 === 1) items.push(items[items.length - 1]); // gerade machen
                    const zpl = buildBatchTagsZpl(items);
                    await printRawZpl(zpl, bulkPrinter);
                    setShowBulkPrint(false);
                    setPrintMode(false);
                    setPrintSelectedIds(new Set());
                  } catch (e) {
                    setBulkError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBulkBusy(false);
                  }
                }}>{bulkBusy ? 'Printing...' : `Print ${tagCount}`}</Button>
              </div>
            </>
          );
        })()}
      </Modal>
    </PageLayout>
  );
}
