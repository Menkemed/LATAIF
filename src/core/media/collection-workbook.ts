// ════════════════════════════════════════════════════════════════════════════
// MEDIA-CONSUMERS-EXPORT — collection .xlsx workbook builder.
//
// Extracted from WatchList's `exportProductsToExcel` so the workbook + image
// embedding is node-testable (ExcelJS runs under node) with an injected image
// resolver — WITHOUT the native save dialog. The only thing left in the page is
// deriving scope/lot data and handing the finished buffer to `exportFile`.
//
// Image embedding is fail-isolated per row: a product whose image can't be
// resolved/decoded (missing / pending / corrupt) keeps its row and simply gets
// no picture — a single bad image never aborts the workbook.
//
// COLLECTIONS-EXPORT — die Artikeldetails der Kategorien als eigene Spalten, gruppiert:
//   Grunddaten · Artikeldetails · Einkauf und Herkunft · Preise · Bestand und Lager · Weitere Angaben.
// Die Detailspalten kommen AUSSCHLIESSLICH aus den Kategorie-Definitionen (keine erfundenen Felder):
// in Schema-Reihenfolge, gleiche Bezeichnung = eine Spalte, nur Spalten mit mindestens einem Wert.
// Ein Wert erscheint nur, wenn die eigene Kategorie des Artikels das Feld kennt; sonst bleibt die Zelle
// leer. Zahlen bleiben Excel-Zahlen (Einheit im Kopf). Nur lesend.
//
// Aufbau der Mappe: je Kategorie ein eigenes Blatt (Reihenfolge wie die Kategorien, nur die Detailspalten
// dieser Kategorie, eigene Summenzeile), am Ende das Blatt „Total" mit einer Zeile je Kategorie und der
// Gesamtsumme — dieselbe Regel wie die Summenzeilen (eigene Ware, auf Lager).
// ════════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';
import type { Category, CategoryAttribute, Product } from '@/core/models/types';
import { pieceCount } from '@/core/lots/stock-metrics';
import type { LotAggregate } from '@/core/lots/lot-queries';
import type { ExportImage, ExportMediaScope } from '@/core/media/product-image-export-core';
import { attributesForDisplay, stonesSummary } from '@/core/products/stones';

export interface CollectionWorkbookDeps {
  /** Lot aggregates keyed by product id (getStockAggregates result). */
  lotAgg: Map<string, LotAggregate>;
  /** Category id → display name. */
  categoryName: (categoryId: string) => string;
  /** Resolve ONE product's primary image as embeddable bytes, or null to skip. */
  resolveImage: (product: { id: string; images?: string[] }, scope: ExportMediaScope) => Promise<ExportImage | null>;
  /** Authorised media scope for the resolver. */
  scope: ExportMediaScope;
  /** Kategorie-Definitionen in Schema-Reihenfolge (auch deaktivierte) — Quelle der Detailspalten. Ohne: keine Detailspalten. */
  categories?: readonly Category[];
}

type BaseKey =
  | 'image' | 'sku' | 'brand' | 'name' | 'category' | 'cond'
  | 'supplier' | 'psource' | 'pdate' | 'paid'
  | 'pp' | 'ppRange' | 'stockVal' | 'spp' | 'min' | 'max' | 'margin'
  | 'qty' | 'lots' | 'status' | 'storage' | 'days'
  | 'tax' | 'source' | 'notes';

interface BaseColumn { header: string; key: BaseKey; width: number; numFmt?: string }

const MONEY = '#,##0.000';
const COUNT = '#,##0';

/** Die 25 bisherigen Spalten, in Gruppen. „Artikeldetails" (dynamisch) stehen zwischen Grunddaten und Einkauf. */
const GRUNDDATEN: BaseColumn[] = [
  { header: 'Image',     key: 'image',    width: 12 },
  { header: 'SKU',       key: 'sku',      width: 14 },
  { header: 'Brand',     key: 'brand',    width: 16 },
  { header: 'Name',      key: 'name',     width: 26 },
  { header: 'Category',  key: 'category', width: 14 },
  { header: 'Condition', key: 'cond',     width: 12 },
];
const EINKAUF: BaseColumn[] = [
  { header: 'Supplier',        key: 'supplier', width: 16 },
  { header: 'Purchase Source', key: 'psource',  width: 16 },
  { header: 'Purchase Date',   key: 'pdate',    width: 14 },
  { header: 'Paid From',       key: 'paid',     width: 10 },
];
const PREISE: BaseColumn[] = [
  { header: 'Purchase Price (BHD)',     key: 'pp',       width: 16, numFmt: MONEY },
  { header: 'Cost Range (BHD)',         key: 'ppRange',  width: 18 },
  { header: 'Stock Value (BHD)',        key: 'stockVal', width: 16, numFmt: MONEY },
  { header: 'Planned Sale Price (BHD)', key: 'spp',      width: 18, numFmt: MONEY },
  { header: 'Min Sale (BHD)',           key: 'min',      width: 14, numFmt: MONEY },
  { header: 'Max Sale (BHD)',           key: 'max',      width: 14, numFmt: MONEY },
  { header: 'Expected Margin (BHD)',    key: 'margin',   width: 16, numFmt: MONEY },
];
const BESTAND: BaseColumn[] = [
  { header: 'Quantity',         key: 'qty',     width: 9,  numFmt: COUNT },
  { header: 'Lots',             key: 'lots',    width: 8,  numFmt: COUNT },
  { header: 'Stock Status',     key: 'status',  width: 14 },
  { header: 'Storage Location', key: 'storage', width: 16 },
  { header: 'Days in Stock',    key: 'days',    width: 10 },
];
const WEITERE: BaseColumn[] = [
  { header: 'Tax Scheme',  key: 'tax',    width: 14 },
  { header: 'Source Type', key: 'source', width: 12 },
  { header: 'Notes',       key: 'notes',  width: 26 },
];

/** Die bisherigen 25 Kopfzeilen (ohne Detailspalten), in der neuen Reihenfolge. */
export const COLLECTION_BASE_HEADERS: readonly string[] = [...GRUNDDATEN, ...EINKAUF, ...PREISE, ...BESTAND, ...WEITERE].map((c) => c.header);

export interface DetailColumn {
  /** ExcelJS-Spaltenschlüssel (`attr:<n>`). */
  key: string;
  header: string;
  type: CategoryAttribute['type'];
  /** Je Kategorie: welche Merkmale dieser Kategorie in diese Spalte gehören (erstes ausgefülltes zählt). */
  byCategory: Map<string, Array<{ key: string; type: CategoryAttribute['type'] }>>;
}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
/** Die gemeinsame Spalte für Referenz- und Modellnummer (Uhren: „Reference Number", Schmuck/Accessory: „Model No"). */
export const REF_MODEL_HEADER = 'Reference / Model No';
/**
 * Gleiche Bedeutung, andere Schreibweise je Kategorie → eine Spalte:
 * „Serial No" / „Serial No." / „Serial #" = „Serial Number";
 * „Reference Number" / „Ref No" / „Reference" / „Model Number" / „Model No" = „Reference / Model No".
 * Ein bloßes „Model" (Modellname) bleibt eine eigene Spalte.
 */
export function canonicalDetailLabel(label: string): string {
  let s = label.trim().replace(/\s+/g, ' ');
  s = s.replace(/(?:\s+(?:no|nr)\.?|\s*#)$/i, ' Number');
  s = s.replace(/^ref\.?(?=\s|$)/i, 'Reference');
  if (/^(?:reference|reference number|model number)$/i.test(s)) return REF_MODEL_HEADER;
  return s;
}
const headerOf = (a: CategoryAttribute): string => {
  const label = canonicalDetailLabel(a.label);
  return a.unit ? `${label} (${a.unit})` : label;
};
/** Kennnummern stehen vorn und direkt nebeneinander; alle übrigen Merkmale danach in Schema-Reihenfolge. */
const IDENT_ORDER = [norm(REF_MODEL_HEADER), 'serial number'];
const identRank = (header: string): number => {
  const i = IDENT_ORDER.indexOf(norm(header));
  return i < 0 ? IDENT_ORDER.length : i;
};
/** Bezeichnungen der Grundspalten ohne „(BHD)" — ein gleichnamiges Merkmal bekommt keine zweite Spalte. */
const BASE_LABELS = new Set(COLLECTION_BASE_HEADERS.map((h) => norm(h.replace(/\s*\(BHD\)\s*$/, ''))));

const leer = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Der Zellwert eines Merkmals: Zahl bleibt Zahl, Steine als Kurzform, Ja/Nein, Mehrfachauswahl mit Komma. Leer → ''. */
export function detailCellValue(type: CategoryAttribute['type'], value: unknown): string | number {
  if (leer(value)) return '';
  if (type === 'stones') return stonesSummary(value) || '';
  if (type === 'boolean') return value === true || value === 'true' ? 'Yes' : value === false || value === 'false' ? 'No' : String(value);
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : String(value);
  }
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean).join(', ');
  return String(value).trim();
}

function attributesOf(p: Product): Record<string, unknown> {
  const raw = (p as { attributes?: unknown }).attributes;
  let a: unknown = raw;
  if (typeof raw === 'string') { try { a = JSON.parse(raw); } catch { a = {}; } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return {};
  // Anzeige-Werte (z. B. Diamond Weight aus den Steinzeilen) — wie Karte, Merkmalliste und Druck.
  return attributesForDisplay(p.categoryId, a as Record<string, unknown>) as Record<string, unknown>;
}

/**
 * Der Wert eines Artikels in einer Detailspalte: das ausgefüllte passende Merkmal seiner Kategorie, sonst ''.
 * Hat eine Kategorie zwei Merkmale für dieselbe Spalte (z. B. Referenz UND Modellnummer) mit verschiedenen
 * Werten, stehen beide da („A / B") — es geht nichts verloren.
 */
function detailValueFor(col: DetailColumn, p: Product, attrs: Record<string, unknown> | undefined): string | number {
  const vals: Array<string | number> = [];
  for (const m of col.byCategory.get(p.categoryId) ?? []) {
    const v = detailCellValue(m.type, attrs?.[m.key]);
    if (v !== '' && !vals.some((x) => String(x) === String(v))) vals.push(v);
  }
  if (vals.length === 0) return '';
  return vals.length === 1 ? vals[0] : vals.map(String).join(' / ');
}

/**
 * Die Detailspalten für genau diese Artikel: aus den Definitionen ihrer Kategorien; Kennnummern (Reference,
 * Serial, Model) vorn nebeneinander, danach Schema-Reihenfolge. Gleiche Bezeichnung (inkl. Einheit, nach
 * Vereinheitlichung „No" = „Number") = eine Spalte, Grundspalten-Namen ausgenommen, und nur Spalten, in denen
 * mindestens ein exportierter Artikel einen Wert hat.
 */
export function collectionDetailColumns(items: readonly Product[], categories: readonly Category[] | undefined): DetailColumn[] {
  if (!categories || categories.length === 0) return [];
  const present = new Set(items.map((p) => p.categoryId));
  const cols: DetailColumn[] = [];
  const byHeader = new Map<string, DetailColumn>();
  for (const cat of categories) {
    if (!present.has(cat.id)) continue;
    for (const a of cat.attributes ?? []) {
      if (!a || !a.key || !a.label) continue;
      const header = headerOf(a);
      const id = norm(header);
      if (BASE_LABELS.has(norm(a.label))) continue;
      let col = byHeader.get(id);
      if (!col) {
        col = { key: `attr:${cols.length}`, header, type: a.type, byCategory: new Map() };
        byHeader.set(id, col);
        cols.push(col);
      }
      const list = col.byCategory.get(cat.id) ?? [];
      if (!list.some((m) => m.key === a.key)) list.push({ key: a.key, type: a.type });
      col.byCategory.set(cat.id, list);
    }
  }
  const attrs = new Map(items.map((p) => [p.id, attributesOf(p)]));
  return cols
    .filter((c) => items.some((p) => detailValueFor(c, p, attrs.get(p.id)) !== ''))
    .sort((x, y) => identRank(x.header) - identRank(y.header));   // stabil: Rest bleibt in Schema-Reihenfolge
}

/** Summen eines Blatts — dieselbe Regel für die Summenzeile des Blatts und das Blatt „Total". */
export interface SheetTotals {
  items: number;
  inStock: number;
  sold: number;
  other: number;
  /** Stück eigener Ware auf Lager. */
  pieces: number;
  /** Einkaufswert eigener Ware auf Lager (aus den Lots, sonst Preis × Stück). */
  stockValue: number;
  /** Geplanter Verkaufswert eigener Ware auf Lager. */
  plannedSale: number;
}

const isInStock = (p: Product): boolean => p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK';
const isSold = (p: Product): boolean => p.stockStatus === 'sold' || p.stockStatus === 'SOLD';

export function sheetTotals(items: readonly Product[], lotAgg: Map<string, LotAggregate>): SheetTotals {
  const ownInStock = items.filter((p) => isInStock(p) && p.sourceType === 'OWN');
  let pieces = 0, stockValue = 0;
  for (const p of ownInStock) {
    const a = lotAgg.get(p.id);
    if (a) { pieces += a.totalQty; stockValue += a.totalValue; }
    else   { pieces += pieceCount(p.quantity); stockValue += p.purchasePrice * pieceCount(p.quantity); }
  }
  const plannedSale = ownInStock.reduce((s, p) => s + (p.plannedSalePrice || 0) * pieceCount(p.quantity), 0);
  const inStock = items.filter(isInStock).length;
  const sold = items.filter(isSold).length;
  return { items: items.length, inStock, sold, other: items.length - inStock - sold, pieces, stockValue, plannedSale };
}

/** Die Detailwerte eines Artikels für genau diese Spalten (Schlüssel = Spaltenschlüssel). */
export function detailRowValues(details: readonly DetailColumn[], p: Product): Record<string, string | number> {
  const attrs = details.length ? attributesOf(p) : {};
  const out: Record<string, string | number> = {};
  for (const d of details) out[d.key] = detailValueFor(d, p, attrs);
  return out;
}

/** Excel-taugliche, eindeutige Blattnamen: ohne \ / ? * [ ] :, höchstens 31 Zeichen. */
export function uniqueSheetName(raw: string, used: Set<string>): string {
  const base = (raw.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '') || 'Other').slice(0, 31).trim();
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length).trim() + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

export const styleHeaderRow = (row: ExcelJS.Row): void => {
  row.font = { bold: true, size: 11, color: { argb: 'FF0F0F10' } };
  row.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 22;
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F7FA' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFC6A36D' } } };
  });
};
export const styleTotalRow = (row: ExcelJS.Row): void => {
  row.height = 22;
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F0F10' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
};

/** Build the Collection workbook and return its .xlsx bytes. Never throws for a
 *  single unreadable image — that row just omits its picture.
 *  Je Kategorie ein Blatt, am Ende das Blatt „Total". */
export async function buildCollectionWorkbookBuffer(
  items: Product[],
  deps: CollectionWorkbookDeps,
): Promise<ArrayBuffer> {
  const { categoryName } = deps;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'LATAIF';
  wb.created = new Date();

  // Artikel nach Kategorie, in der Reihenfolge der Kategorie-Definitionen; Unbekannte danach nach Name.
  const groups = new Map<string, Product[]>();
  for (const p of items) {
    const g = groups.get(p.categoryId);
    if (g) g.push(p); else groups.set(p.categoryId, [p]);
  }
  const order = (deps.categories ?? []).map((c) => c.id);
  const rank = (id: string): number => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  const ids = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || categoryName(a).localeCompare(categoryName(b)));

  const used = new Set<string>(['total']);   // „Total" ist für das Summenblatt reserviert
  const summary: Array<{ label: string; sheet: string; totals: SheetTotals }> = [];
  if (ids.length === 0) {
    await addCategorySheet(wb, uniqueSheetName('Collection', used), [], deps);
  }
  for (const id of ids) {
    const label = categoryName(id) || 'Other';
    const sheet = uniqueSheetName(label, used);
    const totals = await addCategorySheet(wb, sheet, groups.get(id)!, deps);
    summary.push({ label, sheet, totals });
  }
  addTotalSheet(wb, summary);

  return wb.xlsx.writeBuffer();
}

/** Das Summenblatt am Ende: eine Zeile je Kategorie (mit Sprung zum Blatt) und die Gesamtsumme. */
function addTotalSheet(wb: ExcelJS.Workbook, summary: Array<{ label: string; sheet: string; totals: SheetTotals }>): void {
  const ws = wb.addWorksheet('Total');
  ws.columns = [
    { header: 'Category',                 key: 'cat',         width: 28 },
    { header: 'Items',                    key: 'items',       width: 10, style: { numFmt: COUNT } },
    { header: 'In Stock',                 key: 'inStock',     width: 10, style: { numFmt: COUNT } },
    { header: 'Sold',                     key: 'sold',        width: 10, style: { numFmt: COUNT } },
    { header: 'Other Status',             key: 'other',       width: 13, style: { numFmt: COUNT } },
    { header: 'Pieces in Stock',          key: 'pieces',      width: 15, style: { numFmt: COUNT } },
    { header: 'Stock Value (BHD)',        key: 'stockValue',  width: 18, style: { numFmt: MONEY } },
    { header: 'Planned Sale Value (BHD)', key: 'plannedSale', width: 24, style: { numFmt: MONEY } },
  ];
  styleHeaderRow(ws.getRow(1));
  const sum: SheetTotals = { items: 0, inStock: 0, sold: 0, other: 0, pieces: 0, stockValue: 0, plannedSale: 0 };
  for (const s of summary) {
    const row = ws.addRow({ ...s.totals, cat: { text: s.label, hyperlink: `#'${s.sheet.replace(/'/g, "''")}'!A1` } });
    row.getCell('cat').font = { color: { argb: 'FF1F4E79' }, underline: true };
    for (const k of Object.keys(sum) as Array<keyof SheetTotals>) sum[k] += s.totals[k];
  }
  styleTotalRow(ws.addRow({ cat: 'TOTAL', ...sum }));
  ws.addRow({});
  const note = ws.addRow({ cat: 'Pieces in Stock, Stock Value and Planned Sale Value: own goods in stock only — same rule as the TOTAL row on each sheet.' });
  note.getCell('cat').font = { italic: true, color: { argb: 'FF6B6B6B' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Ein Kategorie-Blatt: Grundspalten + die Detailspalten genau dieser Artikel, Bilder, Summenzeile. */
async function addCategorySheet(wb: ExcelJS.Workbook, sheetName: string, items: readonly Product[], deps: CollectionWorkbookDeps): Promise<SheetTotals> {
  const { lotAgg, categoryName, resolveImage, scope } = deps;
  const ws = wb.addWorksheet(sheetName);

  const details = collectionDetailColumns(items, deps.categories);
  const asCol = (c: BaseColumn): Partial<ExcelJS.Column> => ({ header: c.header, key: c.key, width: c.width, ...(c.numFmt ? { style: { numFmt: c.numFmt } } : {}) });
  const detailCols: Array<Partial<ExcelJS.Column>> = details.map((d) => ({
    header: d.header, key: d.key, width: Math.min(30, Math.max(12, d.header.length + 2)),
    ...(d.type === 'number' ? { style: { numFmt: '#,##0.###' } } : {}),
  }));
  ws.columns = [
    ...GRUNDDATEN.map(asCol), ...detailCols, ...EINKAUF.map(asCol), ...PREISE.map(asCol), ...BESTAND.map(asCol), ...WEITERE.map(asCol),
  ];

  // Header-Row Styling.
  const header = ws.getRow(1);
  styleHeaderRow(header);
  // Gruppengrenzen: eine feine Linie links am ersten Kopf jeder Gruppe (Details, Einkauf, Preise, Bestand, Weitere).
  const gruppenStart = [details[0]?.key, EINKAUF[0].key, PREISE[0].key, BESTAND[0].key, WEITERE[0].key].filter(Boolean) as string[];
  for (const k of gruppenStart) {
    const cell = header.getCell(k);
    cell.border = { ...cell.border, left: { style: 'thin', color: { argb: 'FFC6A36D' } } };
  }

  // Data-Rows + Image-Embedding.
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const a = lotAgg.get(p.id);
    const fmt3 = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const detailValues = detailRowValues(details, p);
    const row = ws.addRow({
      image:    '', // Platzhalter — Bild wird via addImage über die Zelle gelegt.
      sku:      p.sku || '',
      brand:    p.brand,
      name:     p.name,
      category: categoryName(p.categoryId),
      cond:     p.condition || '',
      ...detailValues,
      supplier: p.supplierName || '',
      psource:  p.purchaseSource || '',
      pdate:    p.purchaseDate || '',
      paid:     p.paidFrom || '',
      pp:       a ? a.weightedAvg : p.purchasePrice,
      ppRange:  a && a.lotCount > 1 ? `${fmt3(a.minCost)}–${fmt3(a.maxCost)}` : '',
      stockVal: a ? a.totalValue : p.purchasePrice * pieceCount(p.quantity),
      spp:      p.plannedSalePrice ?? '',
      min:      p.minSalePrice ?? '',
      max:      p.maxSalePrice ?? '',
      margin:   p.expectedMargin ?? '',
      qty:      a ? a.totalQty : pieceCount(p.quantity),
      lots:     a ? a.lotCount : 1,
      status:   p.stockStatus,
      storage:  p.storageLocation || '',
      days:     p.daysInStock ?? '',
      tax:      p.taxScheme === 'MARGIN' ? 'Margin Scheme' : p.taxScheme === 'VAT_10' ? 'VAT 10%' : 'Zero',
      source:   p.sourceType,
      notes:    p.notes || '',
    });
    row.height = 60; // ~80 px — passt zu 75x75 Bild.
    row.alignment = { vertical: 'middle' };

    // Primärbild auflösen (Legacy-Spalte ODER Media-Pipeline via Resolver) und
    // einbetten. Fehlerisoliert: ein defektes/fehlendes Bild lässt die Zeile
    // bestehen und bricht den Export nicht ab.
    try {
      const img = await resolveImage(p, scope);
      if (img) {
        const imgId = wb.addImage({ buffer: img.bytes as unknown as ArrayBuffer, extension: img.extension });
        // tl/br positioning: Spalte 0 = Image, Datenzeile = i+1 (Header ist row 0).
        // Wir setzen tl + ext (size in pixel) statt br, damit die Zelle nicht streckt.
        ws.addImage(imgId, {
          tl: { col: 0.1, row: i + 1.1 },
          ext: { width: 70, height: 70 },
          editAs: 'oneCell',
        });
      }
    } catch {
      // Kein absoluter Pfad / keine sensiblen Daten — nur die Produkt-ID.
      console.warn('[Excel-Export] image embed skipped for product', p.id);
    }
  }

  // Totals-Row (nur OWN, in_stock). Stock Value kommt aus stock_lots wenn vorhanden.
  const totals = sheetTotals(items, lotAgg);
  styleTotalRow(ws.addRow({
    image: '', sku: '', brand: '', name: 'TOTAL (OWN · In Stock)', category: '',
    qty: totals.pieces, cond: '', pp: '', ppRange: '', stockVal: totals.stockValue, lots: '', spp: totals.plannedSale,
  }));

  // Kopfzeile fixieren beim Scrollen.
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return totals;
}
