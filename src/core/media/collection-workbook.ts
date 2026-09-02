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
// ════════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';
import type { Product } from '@/core/models/types';
import { pieceCount } from '@/core/lots/stock-metrics';
import type { LotAggregate } from '@/core/lots/lot-queries';
import type { ExportImage, ExportMediaScope } from '@/core/media/product-image-export-core';

export interface CollectionWorkbookDeps {
  /** Lot aggregates keyed by product id (getStockAggregates result). */
  lotAgg: Map<string, LotAggregate>;
  /** Category id → display name. */
  categoryName: (categoryId: string) => string;
  /** Resolve ONE product's primary image as embeddable bytes, or null to skip. */
  resolveImage: (product: { id: string; images?: string[] }, scope: ExportMediaScope) => Promise<ExportImage | null>;
  /** Authorised media scope for the resolver. */
  scope: ExportMediaScope;
}

/** Build the Collection workbook and return its .xlsx bytes. Never throws for a
 *  single unreadable image — that row just omits its picture. */
export async function buildCollectionWorkbookBuffer(
  items: Product[],
  deps: CollectionWorkbookDeps,
): Promise<ArrayBuffer> {
  const { lotAgg, categoryName, resolveImage, scope } = deps;

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
      category: categoryName(p.categoryId),
      qty:      a ? a.totalQty : pieceCount(p.quantity),
      cond:     p.condition || '',
      pp:       a ? a.weightedAvg : p.purchasePrice,
      ppRange:  a && a.lotCount > 1 ? `${fmt3(a.minCost)}–${fmt3(a.maxCost)}` : '',
      stockVal: a ? a.totalValue : p.purchasePrice * pieceCount(p.quantity),
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
  const ownInStock = items.filter(p =>
    (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
  );
  let totalQty = 0, totalEK = 0;
  for (const p of ownInStock) {
    const a = lotAgg.get(p.id);
    if (a) { totalQty += a.totalQty; totalEK += a.totalValue; }
    else   { totalQty += pieceCount(p.quantity); totalEK += p.purchasePrice * pieceCount(p.quantity); }
  }
  const totalVK = ownInStock.reduce((s, p) => s + (p.plannedSalePrice || 0) * pieceCount(p.quantity), 0);

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

  return wb.xlsx.writeBuffer();
}
