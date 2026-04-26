import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, FileSpreadsheet, Check, AlertTriangle, X } from 'lucide-react';
import { read, utils } from 'xlsx';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { useProductStore } from '@/stores/productStore';

interface RawRow {
  [key: string]: string | number | undefined;
}

interface MappedProduct {
  sku: string;
  categoryId: string;
  categoryName: string;
  brand: string;
  name: string;
  referenceNo: string;
  serialNo: string;
  description1: string;
  description2: string;
  description3: string;
  size: string;
  material: string;
  purchasePrice: number;
  plannedSalePrice: number;
  markup: string;
  qty: number;
  isSold: boolean;
  valid: boolean;
  error?: string;
}

function cleanNumber(val: string | number | undefined): number {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  return Number(String(val).replace(/[^0-9.\-]/g, '')) || 0;
}

function cleanStr(val: string | number | undefined): string {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

// Case-insensitive, whitespace-tolerant column lookup
function getCol(row: RawRow, ...names: string[]): string | number | undefined {
  const keys = Object.keys(row);
  for (const name of names) {
    const target = name.toLowerCase().replace(/\s+/g, '');
    for (const k of keys) {
      if (k.toLowerCase().replace(/\s+/g, '') === target) {
        return row[k];
      }
    }
  }
  return undefined;
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function ImportPage() {
  const navigate = useNavigate();
  const { createProduct, categories, loadCategories, loadProducts } = useProductStore();
  const [step, setStep] = useState<'upload' | 'preview' | 'importing' | 'done'>('upload');
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [defaultCategoryId, setDefaultCategoryId] = useState('');

  // Load categories on mount (proper effect, not useState)
  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Per-row category override (user can fix wrong detections in preview)
  const [rowCategoryOverride, setRowCategoryOverride] = useState<Record<number, string>>({});

  // Auto-map Excel category names to LATAIF Plan categories (6 groups: WATCH / GOLD_JEWELRY /
  // BRANDED_GOLD_JEWELRY / ORIGINAL_GOLD_JEWELRY / ACCESSORY / SPARE_PART).
  // Legacy v2-Aliase (Watches / Gold & Diamond Jewellery / Original Jewellery / Customize Jewellery
  // / Accessories / Parts / Loose Gems) bleiben erhalten, damit bestehende Excel-Dateien weiter funktionieren.
  const categoryMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cat of categories) {
      map[cat.name.toLowerCase()] = cat.id;

      // ── v3 Plan categories + v2 legacy aliases ──
      if (cat.id === 'cat-watch' || cat.name === 'Watch' || cat.name === 'Watches') {
        map['watch'] = cat.id;
        map['watches'] = cat.id;
        map['timepiece'] = cat.id;
        map['uhr'] = cat.id;
        map['uhren'] = cat.id;
      }
      if (cat.id === 'cat-gold-jewelry' || cat.name === 'Gold Jewelry' || cat.name === 'Customize Jewellery') {
        map['gold jewelry'] = cat.id;
        map['gold jewellery'] = cat.id;
        map['customize'] = cat.id;
        map['custom'] = cat.id;
        map['customised jewellery'] = cat.id;
        map['customized jewellery'] = cat.id;
        map['customize jewelry'] = cat.id;
        map['gold'] = cat.id;
      }
      if (cat.id === 'cat-branded-gold-jewelry' || cat.name === 'Branded Gold Jewelry' || cat.name === 'Gold & Diamond Jewellery') {
        map['branded gold jewelry'] = cat.id;
        map['branded gold jewellery'] = cat.id;
        map['jewellery'] = cat.id;
        map['jewelry'] = cat.id;
        map['jewel'] = cat.id;
        map['diamond jewellery'] = cat.id;
        map['gold & diamond'] = cat.id;
        map['branded'] = cat.id;
      }
      if (cat.id === 'cat-original-gold-jewelry' || cat.name === 'Original Gold Jewelry' || cat.name === 'Original Jewellery') {
        map['original gold jewelry'] = cat.id;
        map['original gold jewellery'] = cat.id;
        map['original'] = cat.id;
        map['branded jewellery'] = cat.id;
        map['original jewelry'] = cat.id;
      }
      if (cat.id === 'cat-accessory' || cat.name === 'Accessory' || cat.name === 'Accessories') {
        map['accessory'] = cat.id;
        map['accessories'] = cat.id;
        map['access'] = cat.id;
        map['bag'] = cat.id;
        map['bags'] = cat.id;
        map['shoe'] = cat.id;
        map['shoes'] = cat.id;
        map['eyewear'] = cat.id;
        map['sunglasses'] = cat.id;
        map['glasses'] = cat.id;
        map['pen'] = cat.id;
        map['lighter'] = cat.id;
        map['wallet'] = cat.id;
        map['cufflink'] = cat.id;
        map['cufflinks'] = cat.id;
      }
      if (cat.id === 'cat-spare-part' || cat.name === 'Spare Part' || cat.name === 'Parts') {
        map['spare part'] = cat.id;
        map['part'] = cat.id;
        map['parts'] = cat.id;
        map['bezel'] = cat.id;
        map['strap'] = cat.id;
        map['dial'] = cat.id;
        map['link'] = cat.id;
        map['links'] = cat.id;
      }
      // Legacy "Loose Gems" → Gold Jewelry (Plan hat keine eigene Gems-Kategorie)
      if (cat.id === 'cat-gold-jewelry') {
        map['gem'] = cat.id;
        map['gems'] = cat.id;
        map['loose gems'] = cat.id;
        map['stone'] = cat.id;
        map['stones'] = cat.id;
        map['diamond'] = cat.id;
        map['diamonds'] = cat.id;
        map['sapphire'] = cat.id;
        map['ruby'] = cat.id;
        map['emerald'] = cat.id;
      }
    }
    return map;
  }, [categories]);

  function resolveCategoryId(rowCategory: string): string {
    if (!rowCategory) return defaultCategoryId || categories[0]?.id || '';
    const normalized = rowCategory.toLowerCase().trim().replace(/\s+/g, ' ');

    // 1. Exact lowercase match via categoryMap (includes aliases)
    const direct = categoryMap[normalized];
    if (direct) return direct;

    // 2. Substring match: any category name that contains our value, or vice versa
    for (const cat of categories) {
      const catName = cat.name.toLowerCase();
      if (catName === normalized) return cat.id;
      if (catName.includes(normalized) || normalized.includes(catName)) return cat.id;
    }

    // 3. Token match: any word in our value matches any word in any category name
    const tokens = normalized.split(/[\s&/-]+/).filter(Boolean);
    for (const cat of categories) {
      const catTokens = cat.name.toLowerCase().split(/[\s&/-]+/).filter(Boolean);
      if (tokens.some(t => catTokens.some(ct => ct === t || ct.startsWith(t) || t.startsWith(ct)))) {
        return cat.id;
      }
    }

    // 4. Fall back to default or first category
    return defaultCategoryId || categories[0]?.id || '';
  }

  // Parse Excel file
  const parseFile = useCallback((file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const workbook = read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = utils.sheet_to_json<RawRow>(firstSheet, { defval: '' });

      if (json.length === 0) return;

      // Filter out empty rows
      const nonEmpty = json.filter(row => {
        const brand = cleanStr(row['Brand'] || row['brand']);
        return brand.length > 0;
      });
      setRawRows(nonEmpty);
      setStep('preview');
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Map raw rows to products
  const mapped: MappedProduct[] = useMemo(() => {
    return rawRows.map((row, idx) => {
      const rawCategory = cleanStr(getCol(row, 'Catergorie', 'Category', 'Categorie', 'Type'));
      const overrideId = rowCategoryOverride[idx];
      const categoryId = overrideId || resolveCategoryId(rawCategory);
      const categoryName = categories.find(c => c.id === categoryId)?.name || rawCategory || 'Unknown';
      const brand = cleanStr(getCol(row, 'Brand'));
      const description1 = cleanStr(getCol(row, 'Description 1'));
      const sku = cleanStr(getCol(row, 'Serial Tag', 'SKU'));
      const model = cleanStr(getCol(row, 'Model', 'Reference'));
      const serialNo = cleanStr(getCol(row, 'Serial', 'Serial No'));
      const description2 = cleanStr(getCol(row, 'Description 2'));
      const description3 = cleanStr(getCol(row, 'Description 3'));
      const size = cleanStr(getCol(row, 'Size'));
      const material = cleanStr(getCol(row, 'Metal', 'Material'));
      const purchasePrice = cleanNumber(getCol(row, 'Cost', 'Purchase Price'));
      const plannedSalePrice = cleanNumber(getCol(row, 'Tag Price', 'Sale Price', 'Price'));
      const markup = cleanStr(getCol(row, 'Markup'));
      const qty = cleanNumber(getCol(row, 'qty', 'Qty', 'QTY', 'Quantity')) || 1;
      const sold = cleanStr(getCol(row, 'Sold', 'Status'));
      const isSold = sold.toLowerCase() === 'sold' || sold.toLowerCase() === 'yes' || sold === '1' || sold.toLowerCase() === 'x';

      // Display name: prefer Description 1 (actual product name) then Model; fall back to Brand
      const name = description1 || model || brand || 'Unknown';

      const errors: string[] = [];
      if (!brand && !description1 && !model) errors.push('No brand or name');
      if (purchasePrice <= 0) errors.push('No cost');
      if (!categoryId) errors.push('No category');

      return {
        sku, categoryId, categoryName, brand, name,
        referenceNo: model,
        serialNo,
        description1, description2, description3, size, material,
        purchasePrice, plannedSalePrice, markup, qty, isSold,
        valid: errors.length === 0,
        error: errors.length > 0 ? errors.join(', ') : undefined,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, categories, categoryMap, defaultCategoryId, rowCategoryOverride]);

  const validCount = mapped.filter(m => m.valid).length;
  const invalidCount = mapped.filter(m => !m.valid).length;
  const totalCost = mapped.filter(m => m.valid).reduce((s, m) => s + m.purchasePrice, 0);
  const totalSale = mapped.filter(m => m.valid).reduce((s, m) => s + m.plannedSalePrice, 0);

  // Do the import
  async function handleImport() {
    setStep('importing');
    let imported = 0;
    let skipped = 0;

    for (const item of mapped) {
      if (!item.valid) { skipped++; continue; }

      try {
        const attrs: Record<string, string | number> = {};
        if (item.referenceNo) attrs.reference_no = item.referenceNo;
        if (item.serialNo) attrs.serial_no = item.serialNo;
        if (item.description1) attrs.description_1 = item.description1;
        if (item.description2) attrs.description_2 = item.description2;
        if (item.description3) attrs.description_3 = item.description3;
        if (item.size) attrs.size = item.size;
        if (item.material) attrs.metal = item.material;
        if (item.markup) attrs.markup = item.markup;

        // Notes as fallback: combine descriptions that didn't fit elsewhere
        const notes = [item.description2, item.description3].filter(Boolean).join(' / ') || undefined;

        const minSale = item.plannedSalePrice ? Math.round(item.plannedSalePrice * 0.85) : undefined;
        const maxSale = item.plannedSalePrice ? Math.round(item.plannedSalePrice * 1.15) : undefined;

        createProduct({
          categoryId: item.categoryId,
          brand: item.brand,
          name: item.name,
          sku: item.sku || undefined,
          quantity: item.qty || 1,
          condition: 'Pre-Owned',
          scopeOfDelivery: [],
          stockStatus: item.isSold ? 'sold' : 'in_stock',
          purchasePrice: item.purchasePrice,
          purchaseCurrency: 'BHD',
          plannedSalePrice: item.plannedSalePrice || undefined,
          minSalePrice: minSale,
          maxSalePrice: maxSale,
          taxScheme: 'MARGIN',
          notes,
          attributes: attrs,
          images: [],
        });
        imported++;
      } catch {
        skipped++;
      }
    }

    setImportedCount(imported);
    setSkippedCount(skipped);
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

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/collection')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Collection
          </button>
        </div>

        <h1 className="text-display-s animate-fade-in" style={{ color: '#0F0F10', marginBottom: 8 }}>Import Stock</h1>
        <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 40 }}>Upload an Excel or CSV file to bulk-import products into your collection.</p>

        {/* STEP 1: Upload */}
        {step === 'upload' && (
          <div className="animate-fade-in">
            <div
              className="rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all duration-300"
              style={{
                height: 300,
                border: `2px dashed ${dragOver ? '#0F0F10' : '#D5D1C4'}`,
                background: dragOver ? 'rgba(198,163,109,0.04)' : '#EFECE2',
              }}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <Upload size={40} strokeWidth={1} style={{ color: dragOver ? '#0F0F10' : '#6B7280', marginBottom: 16 }} />
              <p style={{ fontSize: 16, color: '#4B5563', marginBottom: 4 }}>
                Drop your Excel file here
              </p>
              <p style={{ fontSize: 13, color: '#6B7280' }}>
                or click to browse — .xlsx, .xls, .csv
              </p>
            </div>
            <input id="file-input" type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={handleFileInput} />

            <div style={{ marginTop: 24, padding: '16px 20px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E1D6' }}>
              <span className="text-overline" style={{ marginBottom: 8 }}>EXPECTED COLUMNS</span>
              <p style={{ fontSize: 12, color: '#6B7280', marginTop: 8, lineHeight: 1.8 }}>
                Category, Serial Tag / SKU, Brand, Model / Reference, Serial, Description 1, Description 2, Description 3, Size, Metal / Material, Cost / Purchase Price, Tag Price / Sale Price, <strong style={{ color: '#AA956E' }}>Qty / Quantity</strong>, Sold / Status
              </p>
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                Qty-Spalte optional — wird auf 1 gesetzt wenn nicht vorhanden. Spaltennamen sind case-insensitive.
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

            {/* Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
              <Card>
                <span className="text-overline">TOTAL ROWS</span>
                <span className="font-display" style={{ fontSize: 28, color: '#0F0F10', display: 'block', marginTop: 8 }}>{mapped.length}</span>
              </Card>
              <Card>
                <span className="text-overline">VALID</span>
                <span className="font-display" style={{ fontSize: 28, color: '#7EAA6E', display: 'block', marginTop: 8 }}>{validCount}</span>
              </Card>
              <Card>
                <span className="text-overline">TOTAL COST</span>
                <span className="font-mono" style={{ fontSize: 20, color: '#4B5563', display: 'block', marginTop: 8 }}>{fmt(totalCost)} BHD</span>
              </Card>
              <Card>
                <span className="text-overline">TOTAL TAG PRICE</span>
                <span className="font-mono" style={{ fontSize: 20, color: '#0F0F10', display: 'block', marginTop: 8 }}>{fmt(totalSale)} BHD</span>
              </Card>
            </div>

            {/* Default Category (fallback when not in Excel) */}
            <div style={{ marginBottom: 12, padding: '14px 20px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E1D6' }}>
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
                      border: `1px solid ${defaultCategoryId === cat.id ? cat.color : '#D5D1C4'}`,
                      color: defaultCategoryId === cat.id ? cat.color : '#6B7280',
                      background: defaultCategoryId === cat.id ? cat.color + '08' : 'transparent',
                    }}>
                    <span className="rounded-full" style={{ width: 6, height: 6, background: cat.color }} />
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Detected categories breakdown */}
            {rawRows.length > 0 && (
              <div style={{ marginBottom: 16, padding: '10px 14px', background: '#EFECE2', borderRadius: 8, border: '1px solid #E5E1D6' }}>
                <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Detected categories in this file</span>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(
                    mapped.reduce<Record<string, number>>((acc, m) => {
                      acc[m.categoryName] = (acc[m.categoryName] || 0) + 1;
                      return acc;
                    }, {})
                  ).map(([name, count]) => {
                    const cat = categories.find(c => c.name === name);
                    return (
                      <span key={name} style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 999,
                        background: (cat?.color || '#6B7280') + '15',
                        color: cat?.color || '#6B7280',
                        border: `1px solid ${(cat?.color || '#6B7280')}30`,
                      }}>{name} ({count})</span>
                    );
                  })}
                </div>
              </div>
            )}

            {invalidCount > 0 && (
              <div style={{ marginBottom: 16, padding: '10px 16px', background: 'rgba(170,110,110,0.06)', border: '1px solid rgba(170,110,110,0.15)', borderRadius: 8 }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} style={{ color: '#AA6E6E' }} />
                    <span style={{ fontSize: 13, color: '#AA6E6E' }}>{invalidCount} rows have issues and will be skipped</span>
                  </div>
                  <button onClick={() => setShowErrors(true)} className="cursor-pointer" style={{ fontSize: 11, color: '#AA6E6E', background: 'none', border: 'none', textDecoration: 'underline' }}>View</button>
                </div>
              </div>
            )}

            {/* Preview Table */}
            <div style={{ overflowX: 'auto', marginBottom: 24 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #E5E1D6' }}>
                    {['', 'Category', 'SKU', 'Brand', 'Name', 'Desc 2/3', 'Ref', 'Serial', 'Metal', 'Size', 'Qty', 'Cost', 'Tag Price', 'Status'].map(h => (
                      <th key={h} className="text-overline" style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mapped.slice(0, 30).map((m, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(229,225,214,0.6)' }}>
                      <td style={{ padding: '8px 10px' }}>
                        {m.valid ? <Check size={12} style={{ color: '#7EAA6E' }} /> : <AlertTriangle size={12} style={{ color: '#AA6E6E' }} />}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <span style={{
                          fontSize: 10, padding: '1px 6px', borderRadius: 3,
                          background: `${categories.find(c => c.id === m.categoryId)?.color || '#6B7280'}15`,
                          color: categories.find(c => c.id === m.categoryId)?.color || '#6B7280',
                          border: `1px solid ${categories.find(c => c.id === m.categoryId)?.color || '#6B7280'}30`,
                        }}>{m.categoryName}</span>
                      </td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', fontSize: 11 }}>{m.sku}</td>
                      <td style={{ padding: '8px 10px', color: '#0F0F10' }}>{m.brand}</td>
                      <td style={{ padding: '8px 10px', color: '#0F0F10' }}>{m.name}</td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', fontSize: 11 }}>
                        {m.description2}{m.description3 ? ` / ${m.description3}` : ''}
                      </td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#4B5563', fontSize: 11 }}>{m.referenceNo}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#4B5563', fontSize: 11 }}>{m.serialNo}</td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', fontSize: 11 }}>{m.material}</td>
                      <td style={{ padding: '8px 10px', color: '#6B7280', fontSize: 11 }}>{m.size}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: (m.qty || 1) > 1 ? '#AA956E' : '#6B7280', fontSize: 11 }}>{m.qty || 1}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#4B5563' }}>{fmt(m.purchasePrice)}</td>
                      <td className="font-mono" style={{ padding: '8px 10px', color: '#0F0F10' }}>{fmt(m.plannedSalePrice)}</td>
                      <td style={{ padding: '8px 10px' }}>
                        {m.isSold && <span style={{ fontSize: 10, color: '#6B7280', background: '#E5E1D6', padding: '1px 6px', borderRadius: 3 }}>Sold</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mapped.length > 30 && (
                <p style={{ padding: '12px 10px', fontSize: 12, color: '#6B7280' }}>...and {mapped.length - 30} more rows</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between" style={{ padding: '20px 0', borderTop: '1px solid #E5E1D6' }}>
              <Button variant="ghost" onClick={() => { setStep('upload'); setRawRows([]); }}>Cancel</Button>
              <div className="flex items-center gap-3">
                <span style={{ fontSize: 13, color: '#6B7280' }}>
                  {validCount} items across {new Set(mapped.filter(m => m.valid).map(m => m.categoryName)).size} categories, <strong style={{ color: '#AA956E' }}>Margin Scheme</strong>
                </span>
                <Button variant="primary" onClick={handleImport} disabled={validCount === 0}>
                  Import {validCount} Items
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: Importing */}
        {step === 'importing' && (
          <div className="animate-fade-in flex flex-col items-center justify-center" style={{ padding: '80px 0' }}>
            <div className="animate-shimmer" style={{ width: 120, height: 2, borderRadius: 1, marginBottom: 24 }} />
            <p style={{ fontSize: 16, color: '#4B5563' }}>Importing products...</p>
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
            {skippedCount > 0 && (
              <p style={{ fontSize: 13, color: '#6B7280' }}>{skippedCount} rows skipped</p>
            )}
            <div className="flex gap-3" style={{ marginTop: 32 }}>
              <Button variant="ghost" onClick={() => { setStep('upload'); setRawRows([]); }}>Import More</Button>
              <Button variant="primary" onClick={() => navigate('/collection')}>View Collection</Button>
            </div>
          </div>
        )}

        {/* Error Modal */}
        <Modal open={showErrors} onClose={() => setShowErrors(false)} title="Import Issues" width={600}>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {mapped.filter(m => !m.valid).map((m, i) => (
              <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #E5E1D6', fontSize: 12 }}>
                <span style={{ color: '#0F0F10' }}>{m.sku || m.brand || `Row ${i + 1}`}</span>
                <span style={{ color: '#AA6E6E', marginLeft: 12 }}>{m.error}</span>
              </div>
            ))}
          </div>
        </Modal>
      </div>
    </div>
  );
}
