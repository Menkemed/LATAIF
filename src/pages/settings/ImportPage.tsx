import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, FileSpreadsheet, Check, AlertTriangle, X } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { read, utils } from 'xlsx';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { useProductStore } from '@/stores/productStore';
import { createPreDestructiveBackup } from '@/core/settings/pre-destructive-backup';
import {
  classifyRows, summarize, canStartImport, runProductImport, buildExistingIndex, cleanStr, getCol,
  VAT_SCHEMES,
  type RawRow, type ClassifiedRow, type ImportRowStatus,
} from '@/core/import/product-import';
import type { TaxScheme } from '@/core/models/types';

const VAT_LABEL: Record<TaxScheme, string> = {
  VAT_10: 'Standard 10% (VAT_10)',
  ZERO: 'Zero-rated (ZERO)',
  MARGIN: 'Profit Margin (MARGIN)',
};

const STATUS_COLOR: Record<ImportRowStatus, string> = {
  new: '#7EAA6E',
  warning: '#AA956E',
  duplicate: '#6B7280',
  invalid: '#AA6E6E',
};

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Backup läuft NUR in der Desktop-App (Tauri). Im Browser/Dev ist kein sicheres Backup
// möglich → Import wird geblockt (kein Insert ohne Backup).
function canBackupHere(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function ImportPage() {
  const navigate = useNavigate();
  const goBack = useGoBack('/collection');
  const { createProduct, categories, loadCategories, loadProducts, products } = useProductStore();
  const [step, setStep] = useState<'upload' | 'preview' | 'importing' | 'done'>('upload');
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [importedCount, setImportedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [defaultCategoryId, setDefaultCategoryId] = useState('');
  const [defaultVatScheme, setDefaultVatScheme] = useState<TaxScheme | null>(null);
  const [rowCategoryOverride, setRowCategoryOverride] = useState<Record<number, string>>({});
  const [backupError, setBackupError] = useState('');
  const [backupLocation, setBackupLocation] = useState('');

  // Kategorien UND Produkte laden: Produkte sind der Duplicate-Detection-Index.
  useEffect(() => { loadCategories(); loadProducts(); }, [loadCategories, loadProducts]);

  const canBackup = canBackupHere();

  // Auto-map Excel-Kategorienamen → LATAIF Plan-Kategorien (+ Legacy-v2-Aliase).
  const categoryMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cat of categories) {
      map[cat.name.toLowerCase()] = cat.id;
      if (cat.id === 'cat-watch' || cat.name === 'Watch' || cat.name === 'Watches') {
        map['watch'] = cat.id; map['watches'] = cat.id; map['timepiece'] = cat.id; map['uhr'] = cat.id; map['uhren'] = cat.id;
      }
      if (cat.id === 'cat-gold-jewelry' || cat.name === 'Gold Jewelry' || cat.name === 'Customize Jewellery') {
        map['gold jewelry'] = cat.id; map['gold jewellery'] = cat.id; map['customize'] = cat.id; map['custom'] = cat.id;
        map['customised jewellery'] = cat.id; map['customized jewellery'] = cat.id; map['customize jewelry'] = cat.id; map['gold'] = cat.id;
      }
      if (cat.id === 'cat-branded-gold-jewelry' || cat.name === 'Branded Gold Jewelry' || cat.name === 'Gold & Diamond Jewellery') {
        map['branded gold jewelry'] = cat.id; map['branded gold jewellery'] = cat.id; map['jewellery'] = cat.id; map['jewelry'] = cat.id;
        map['jewel'] = cat.id; map['diamond jewellery'] = cat.id; map['gold & diamond'] = cat.id; map['branded'] = cat.id;
      }
      if (cat.id === 'cat-original-gold-jewelry' || cat.name === 'Original Gold Jewelry' || cat.name === 'Original Jewellery') {
        map['original gold jewelry'] = cat.id; map['original gold jewellery'] = cat.id; map['original'] = cat.id;
        map['branded jewellery'] = cat.id; map['original jewelry'] = cat.id;
      }
      if (cat.id === 'cat-accessory' || cat.name === 'Accessory' || cat.name === 'Accessories') {
        map['accessory'] = cat.id; map['accessories'] = cat.id; map['access'] = cat.id; map['bag'] = cat.id; map['bags'] = cat.id;
        map['shoe'] = cat.id; map['shoes'] = cat.id; map['eyewear'] = cat.id; map['sunglasses'] = cat.id; map['glasses'] = cat.id;
        map['pen'] = cat.id; map['lighter'] = cat.id; map['wallet'] = cat.id; map['cufflink'] = cat.id; map['cufflinks'] = cat.id;
      }
      if (cat.id === 'cat-spare-part' || cat.name === 'Spare Part' || cat.name === 'Parts') {
        map['spare part'] = cat.id; map['part'] = cat.id; map['parts'] = cat.id; map['bezel'] = cat.id; map['strap'] = cat.id;
        map['dial'] = cat.id; map['link'] = cat.id; map['links'] = cat.id;
      }
      if (cat.id === 'cat-gold-jewelry') {
        map['gem'] = cat.id; map['gems'] = cat.id; map['loose gems'] = cat.id; map['stone'] = cat.id; map['stones'] = cat.id;
        map['diamond'] = cat.id; map['diamonds'] = cat.id; map['sapphire'] = cat.id; map['ruby'] = cat.id; map['emerald'] = cat.id;
      }
    }
    return map;
  }, [categories]);

  // Kategorie-Resolver: liefert {id, name, matched}. matched=false ⇒ auf Default gefallen (→ warning).
  // Per-Zeilen-Override (Preview) hat Vorrang.
  const resolveCategory = useCallback((rawCategory: string, rowIndex: number) => {
    const nameOf = (id: string) => categories.find(c => c.id === id)?.name || '';
    const override = rowCategoryOverride[rowIndex];
    if (override) return { id: override, name: nameOf(override), matched: true };

    const fallbackId = defaultCategoryId || categories[0]?.id || '';
    if (!rawCategory) return { id: fallbackId, name: nameOf(fallbackId), matched: false };

    const normalized = rawCategory.toLowerCase().trim().replace(/\s+/g, ' ');
    const direct = categoryMap[normalized];
    if (direct) return { id: direct, name: nameOf(direct), matched: true };
    for (const cat of categories) {
      const catName = cat.name.toLowerCase();
      if (catName === normalized || catName.includes(normalized) || normalized.includes(catName)) {
        return { id: cat.id, name: cat.name, matched: true };
      }
    }
    const tokens = normalized.split(/[\s&/-]+/).filter(Boolean);
    for (const cat of categories) {
      const catTokens = cat.name.toLowerCase().split(/[\s&/-]+/).filter(Boolean);
      if (tokens.some(t => catTokens.some(ct => ct === t || ct.startsWith(t) || t.startsWith(ct)))) {
        return { id: cat.id, name: cat.name, matched: true };
      }
    }
    return { id: fallbackId, name: nameOf(fallbackId), matched: false };
  }, [categories, categoryMap, defaultCategoryId, rowCategoryOverride]);

  const existingIndex = useMemo(() => buildExistingIndex(products), [products]);

  const classified: ClassifiedRow[] = useMemo(
    () => classifyRows(rawRows, { resolveCategory, defaultVatScheme, existingIndex }),
    [rawRows, resolveCategory, defaultVatScheme, existingIndex],
  );
  const summary = useMemo(() => summarize(classified), [classified]);
  const vatSelected = defaultVatScheme !== null;
  const importReady = canStartImport({ canBackup, vatSelected, summary });

  // Excel/CSV parsen (nur lesen; nichts wird geschrieben).
  const parseFile = useCallback((file: File) => {
    setFileName(file.name);
    setBackupError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const workbook = read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = utils.sheet_to_json<RawRow>(firstSheet, { defval: '' });
      if (json.length === 0) return;
      // Leere Zeilen raus: mindestens eine Identität vorhanden.
      const nonEmpty = json.filter(row => {
        const brand = cleanStr(getCol(row, 'Brand'));
        const d1 = cleanStr(getCol(row, 'Description 1'));
        const ref = cleanStr(getCol(row, 'Model', 'Reference'));
        const sku = cleanStr(getCol(row, 'Serial Tag', 'SKU'));
        return (brand || d1 || ref || sku).length > 0;
      });
      setRowCategoryOverride({});
      setRawRows(nonEmpty);
      setStep('preview');
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Eine importierbare Zeile → createProduct. Attribute + Preisbänder werden hier gemappt.
  const createFromRow = useCallback((item: ClassifiedRow) => {
    const attrs: Record<string, string | number> = {};
    if (item.referenceNo) attrs.reference_no = item.referenceNo;
    if (item.serialNo) attrs.serial_no = item.serialNo;
    if (item.description1) attrs.description_1 = item.description1;
    if (item.description2) attrs.description_2 = item.description2;
    if (item.description3) attrs.description_3 = item.description3;
    if (item.size) attrs.size = item.size;
    if (item.material) attrs.metal = item.material;
    if (item.markup) attrs.markup = item.markup;
    if (item.weight != null) attrs.weight = item.weight;
    if (item.carat != null) attrs.carat = item.carat;
    if (item.diamondWeight != null) attrs.diamond_weight = item.diamondWeight;

    const notes = [item.description2, item.description3].filter(Boolean).join(' / ') || undefined;
    const minSale = item.plannedSalePrice ? Math.round(item.plannedSalePrice * 0.85) : undefined;
    const maxSale = item.plannedSalePrice ? Math.round(item.plannedSalePrice * 1.15) : undefined;

    createProduct({
      categoryId: item.categoryId,
      brand: item.brand,
      name: item.name,
      sku: item.sku || undefined,
      quantity: item.quantity || 1,
      condition: 'Pre-Owned',
      scopeOfDelivery: [],
      stockStatus: item.isSold ? 'sold' : 'in_stock',
      purchasePrice: item.purchasePrice,
      purchaseCurrency: 'BHD',
      plannedSalePrice: item.plannedSalePrice || undefined,
      minSalePrice: minSale,
      maxSalePrice: maxSale,
      // Importierbare Zeilen haben immer ein aufgelöstes Scheme (sonst invalid + ausgeschlossen);
      // der null-Fall ist unerreichbar — kein hartes MARGIN-Literal mehr im Import-Pfad.
      taxScheme: item.taxScheme ?? undefined,
      notes,
      attributes: attrs,
      images: [],
    });
  }, [createProduct]);

  // Import: Backup-first → ohne Erfolg KEIN createProduct. Danach per-Row (nicht atomar).
  async function handleImport() {
    if (!importReady) return;
    setStep('importing');
    setBackupError('');

    const res = await runProductImport(classified, {
      backup: () => createPreDestructiveBackup('import-products'),
      create: createFromRow,
    });

    if (!res.started) {
      setBackupError(res.backupError || 'Backup failed');
      setStep('preview');
      return;
    }
    setBackupLocation(res.backupLocation || '');
    setImportedCount(res.imported);
    setFailedCount(res.failed);
    setStep('done');
    loadProducts();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv'))) {
      parseFile(file);
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  }

  const invalidRows = classified.filter(r => r.status === 'invalid');
  const previewRows = classified.slice(0, 30);

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

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
        </div>

        <h1 className="text-display-s animate-fade-in" style={{ color: '#0F0F10', marginBottom: 8 }}>Import Stock</h1>
        <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 40 }}>Upload an Excel or CSV file to bulk-import products. A backup is created before anything is written; duplicates and invalid rows are blocked.</p>

        {/* STEP 1: Upload */}
        {step === 'upload' && (
          <div className="animate-fade-in">
            <div
              className="rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all duration-300"
              style={{
                height: 300,
                border: `2px dashed ${dragOver ? '#0F0F10' : '#D5D9DE'}`,
                background: dragOver ? 'rgba(198,163,109,0.04)' : '#F2F7FA',
              }}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <Upload size={40} strokeWidth={1} style={{ color: dragOver ? '#0F0F10' : '#6B7280', marginBottom: 16 }} />
              <p style={{ fontSize: 16, color: '#4B5563', marginBottom: 4 }}>Drop your Excel file here</p>
              <p style={{ fontSize: 13, color: '#6B7280' }}>or click to browse — .xlsx, .xls, .csv</p>
            </div>
            <input id="file-input" type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleFileInput} />

            <div style={{ marginTop: 24, padding: '16px 20px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <span className="text-overline" style={{ marginBottom: 8 }}>EXPECTED COLUMNS</span>
              <p style={{ fontSize: 12, color: '#6B7280', marginTop: 8, lineHeight: 1.8 }}>
                Category, Serial Tag / SKU, Brand, Model / Reference, Serial, Description 1-3, Size, Metal / Material, Cost / Purchase Price, Tag Price / Sale Price, <strong style={{ color: '#AA956E' }}>Qty / Quantity</strong>, <strong style={{ color: '#AA956E' }}>VAT / Tax Scheme</strong>, Weight, Carat, Diamond Weight, Sold / Status
              </p>
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                Numbers accept both formats (1,234.50 and 1.234,50). Missing VAT scheme → pick a default in the preview. Column names are case-insensitive.
              </p>
            </div>
          </div>
        )}

        {/* STEP 2: Preview */}
        {step === 'preview' && (
          <div className="animate-fade-in">
            {/* File Info */}
            <div className="flex items-center gap-3" style={{ marginBottom: 24 }}>
              <FileSpreadsheet size={20} style={{ color: '#0F0F10' }} />
              <span style={{ fontSize: 14, color: '#0F0F10' }}>{fileName}</span>
              <button onClick={() => { setStep('upload'); setRawRows([]); }}
                className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280', padding: 4 }}>
                <X size={14} />
              </button>
            </div>

            {/* Summary buckets */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
              <Card><span className="text-overline">TOTAL ROWS</span><span className="font-display" style={{ fontSize: 26, color: '#0F0F10', display: 'block', marginTop: 8 }}>{summary.total}</span></Card>
              <Card><span className="text-overline">NEW</span><span className="font-display" style={{ fontSize: 26, color: STATUS_COLOR.new, display: 'block', marginTop: 8 }}>{summary.new}</span></Card>
              <Card><span className="text-overline">WARNINGS</span><span className="font-display" style={{ fontSize: 26, color: STATUS_COLOR.warning, display: 'block', marginTop: 8 }}>{summary.warning}</span></Card>
              <Card><span className="text-overline">DUPLICATES</span><span className="font-display" style={{ fontSize: 26, color: STATUS_COLOR.duplicate, display: 'block', marginTop: 8 }}>{summary.duplicate}</span></Card>
              <Card><span className="text-overline">INVALID</span><span className="font-display" style={{ fontSize: 26, color: STATUS_COLOR.invalid, display: 'block', marginTop: 8 }}>{summary.invalid}</span></Card>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
              <Card><span className="text-overline">TO IMPORT</span><span className="font-display" style={{ fontSize: 22, color: '#0F0F10', display: 'block', marginTop: 8 }}>{summary.importable}</span></Card>
              <Card><span className="text-overline">EST. QTY TOTAL</span><span className="font-mono" style={{ fontSize: 18, color: '#4B5563', display: 'block', marginTop: 8 }}>{fmt(summary.estQtyTotal)}</span></Card>
              <Card><span className="text-overline">EST. TOTAL COST</span><span className="font-mono" style={{ fontSize: 18, color: '#0F0F10', display: 'block', marginTop: 8 }}>{fmt(summary.estCostTotal)} BHD</span></Card>
            </div>

            {/* Default VAT scheme — REQUIRED */}
            <div style={{ marginBottom: 12, padding: '14px 20px', background: '#FFFFFF', borderRadius: 8, border: `1px solid ${vatSelected ? '#E5E9EE' : 'rgba(170,110,110,0.4)'}` }}>
              <span className="text-overline" style={{ color: vatSelected ? undefined : '#AA6E6E' }}>DEFAULT VAT SCHEME (required — per-row VAT column overrides this)</span>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 10 }}>
                {VAT_SCHEMES.map(scheme => (
                  <button key={scheme}
                    onClick={() => setDefaultVatScheme(scheme)}
                    className="cursor-pointer rounded-lg transition-all duration-200"
                    style={{
                      padding: '6px 14px', fontSize: 12,
                      border: `1px solid ${defaultVatScheme === scheme ? '#0F0F10' : '#D5D9DE'}`,
                      color: defaultVatScheme === scheme ? '#0F0F10' : '#6B7280',
                      background: defaultVatScheme === scheme ? 'rgba(198,163,109,0.08)' : 'transparent',
                    }}>{VAT_LABEL[scheme]}</button>
                ))}
              </div>
              {!vatSelected && <p style={{ fontSize: 11, color: '#AA6E6E', marginTop: 8 }}>Import is blocked until a VAT scheme is selected.</p>}
            </div>

            {/* Default Category (fallback) */}
            <div style={{ marginBottom: 12, padding: '14px 20px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="text-overline">DEFAULT CATEGORY (for rows without category)</span>
                {rawRows.length > 0 && (
                  <button
                    onClick={() => {
                      if (!defaultCategoryId) { alert('Pick a default category first.'); return; }
                      const all: Record<number, string> = {};
                      rawRows.forEach((_, i) => { all[i] = defaultCategoryId; });
                      setRowCategoryOverride(all);
                    }}
                    className="cursor-pointer"
                    style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, textDecoration: 'underline' }}
                  >Force all rows → default</button>
                )}
              </div>
              <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                {categories.map(cat => (
                  <button key={cat.id}
                    onClick={() => setDefaultCategoryId(cat.id)}
                    className="cursor-pointer rounded-lg transition-all duration-200"
                    style={{
                      padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                      border: `1px solid ${defaultCategoryId === cat.id ? cat.color : '#D5D9DE'}`,
                      color: defaultCategoryId === cat.id ? cat.color : '#6B7280',
                      background: defaultCategoryId === cat.id ? cat.color + '08' : 'transparent',
                    }}>
                    <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Non-atomic + backup notice */}
            <div style={{ marginBottom: 16, padding: '12px 16px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8 }}>
              <p style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.7 }}>
                <strong style={{ color: '#0F0F10' }}>Before import:</strong> a full backup of your database is created automatically.
                Duplicate and invalid rows are <strong>never</strong> imported. The import runs row-by-row and is <strong>not</strong> a single transaction —
                if an unexpected error occurs partway, some rows may already be saved; the pre-import backup is your rollback point.
              </p>
              {!canBackup && <p style={{ fontSize: 11, color: '#AA6E6E', marginTop: 6 }}>Backup is only available in the desktop app — import is disabled here.</p>}
            </div>

            {backupError && (
              <div style={{ marginBottom: 16, padding: '10px 16px', background: 'rgba(170,110,110,0.06)', border: '1px solid rgba(170,110,110,0.15)', borderRadius: 8 }}>
                <div className="flex items-center gap-2"><AlertTriangle size={14} style={{ color: '#AA6E6E' }} />
                  <span style={{ fontSize: 13, color: '#AA6E6E' }}>Backup failed — nothing was imported: {backupError}</span></div>
              </div>
            )}

            {(summary.invalid > 0 || summary.duplicate > 0) && (
              <div style={{ marginBottom: 16, padding: '10px 16px', background: 'rgba(170,110,110,0.06)', border: '1px solid rgba(170,110,110,0.15)', borderRadius: 8 }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} style={{ color: '#AA6E6E' }} />
                    <span style={{ fontSize: 13, color: '#AA6E6E' }}>{summary.invalid} invalid and {summary.duplicate} duplicate rows will be skipped</span>
                  </div>
                  {summary.invalid > 0 && <button onClick={() => setShowErrors(true)} className="cursor-pointer" style={{ fontSize: 11, color: '#AA6E6E', background: 'none', border: 'none', textDecoration: 'underline' }}>View invalid</button>}
                </div>
              </div>
            )}

            {/* Preview Table */}
            <div style={{ overflowX: 'auto', marginBottom: 24 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #E5E9EE' }}>
                    {['Status', 'Category', 'SKU', 'Brand', 'Name', 'Ref', 'Serial', 'Qty', 'Cost', 'Tag Price', 'VAT', 'Note'].map(h => (
                      <th key={h} className="text-overline" style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((m, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(229,225,214,0.6)' }}>
                      <td style={{ padding: '8px 10px' }}>
                        <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.04em',
                          background: `${STATUS_COLOR[m.status]}15`, color: STATUS_COLOR[m.status], border: `1px solid ${STATUS_COLOR[m.status]}30` }}>{m.status}</span>
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3,
                          background: `${categories.find(c => c.id === m.categoryId)?.color || '#6B7280'}15`,
                          color: categories.find(c => c.id === m.categoryId)?.color || '#6B7280',
                          border: `1px solid ${categories.find(c => c.id === m.categoryId)?.color || '#6B7280'}30` }}>{m.categoryName}</span>
                      </td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', fontSize: 11 }}>{m.sku}</td>
                      <td style={{ padding: '8px 10px', color: '#0F0F10' }}>{m.brand}</td>
                      <td style={{ padding: '8px 10px', color: '#0F0F10' }}>{m.name}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#4B5563', fontSize: 11 }}>{m.referenceNo}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#4B5563', fontSize: 11 }}>{m.serialNo}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: (m.quantity || 1) > 1 ? '#AA956E' : '#6B7280', fontSize: 11 }}>{m.quantity || 1}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#4B5563' }}>{fmt(m.purchasePrice)}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#0F0F10' }}>{m.plannedSalePrice != null ? fmt(m.plannedSalePrice) : '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', fontSize: 11 }}>{m.taxScheme || '—'}</td>
                      <td style={{ padding: '8px 10px', color: m.status === 'invalid' ? '#AA6E6E' : m.status === 'duplicate' ? '#6B7280' : '#AA956E', fontSize: 11 }}>
                        {m.status === 'invalid' ? m.errors.join(', ')
                          : m.status === 'duplicate' ? m.duplicateReason
                          : m.warnings.join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {classified.length > 30 && (
                <p style={{ padding: '12px 10px', fontSize: 12, color: '#6B7280' }}>...and {classified.length - 30} more rows</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between" style={{ padding: '20px 0', borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => { setStep('upload'); setRawRows([]); }}>Cancel</Button>
              <div className="flex items-center gap-3">
                <span style={{ fontSize: 13, color: '#6B7280' }}>
                  {summary.importable} items · VAT {defaultVatScheme ? VAT_LABEL[defaultVatScheme] : '— not set'}
                </span>
                <Button variant="primary" onClick={handleImport} disabled={!importReady}>
                  Import {summary.importable} Items
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: Importing */}
        {step === 'importing' && (
          <div className="animate-fade-in flex flex-col items-center justify-center" style={{ padding: '80px 0' }}>
            <div className="animate-shimmer" style={{ width: 120, height: 2, borderRadius: 1, marginBottom: 24 }} />
            <p style={{ fontSize: 16, color: '#4B5563' }}>Backing up, then importing products...</p>
          </div>
        )}

        {/* STEP 4: Done */}
        {step === 'done' && (
          <div className="animate-fade-in flex flex-col items-center justify-center" style={{ padding: '60px 0' }}>
            <div className="flex items-center justify-center rounded-full" style={{ width: 64, height: 64, background: 'rgba(126,170,110,0.1)', border: '1px solid rgba(126,170,110,0.2)', marginBottom: 24 }}>
              <Check size={28} style={{ color: '#7EAA6E' }} />
            </div>
            <h2 className="font-display" style={{ fontSize: 24, color: '#0F0F10', marginBottom: 8 }}>Import Complete</h2>
            <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 4 }}>
              <strong style={{ color: '#7EAA6E' }}>{importedCount}</strong> products imported successfully
            </p>
            {failedCount > 0 && (
              <p style={{ fontSize: 13, color: '#AA6E6E' }}>{failedCount} rows failed during insert — see the pre-import backup below if you need to roll back.</p>
            )}
            {backupLocation && (
              <p style={{ fontSize: 12, color: '#6B7280', marginTop: 8, maxWidth: 560, textAlign: 'center' }}>Backup created before import: <span className="font-mono" style={{ color: '#4B5563' }}>{backupLocation}</span></p>
            )}
            <div className="flex gap-3" style={{ marginTop: 32 }}>
              <Button variant="ghost" onClick={() => { setStep('upload'); setRawRows([]); setBackupLocation(''); }}>Import More</Button>
              <Button variant="primary" onClick={() => navigate('/collection')}>View Collection</Button>
            </div>
          </div>
        )}

        {/* Invalid rows modal */}
        <Modal open={showErrors} onClose={() => setShowErrors(false)} title="Invalid Rows (will be skipped)" width={600}>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {invalidRows.map((m, i) => (
              <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #E5E9EE', fontSize: 12 }}>
                <span style={{ color: '#0F0F10' }}>{m.sku || m.brand || m.name || `Row ${m.index + 1}`}</span>
                <span style={{ color: '#AA6E6E', marginLeft: 12 }}>{m.errors.join(', ')}</span>
              </div>
            ))}
          </div>
        </Modal>
      </div>
    </div>
  );
}
