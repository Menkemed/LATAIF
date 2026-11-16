// MEDIA-CONSUMERS-EXPORT-I1 — collection workbook builder integration test.
// Drives the REAL production builder src/core/media/collection-workbook.ts with ExcelJS under node,
// an injected image resolver simulating each fixture kind, then RE-READS the produced .xlsx and
// asserts: media + legacy products embed an image, missing/corrupt products keep their row with NO
// image (failure isolation — one bad image never aborts the workbook), all rows + the total present.
// The media→bytes resolution itself is proven by the shared resolver (thumbnails) + export-core test.
// Run: node test/media-export/workbook.test.ts
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

// Der Builder holt sich die eine Stueckzahl-Regel aus `@/core/lots/stock-metrics` — ein echter
// Laufzeit-Import (die uebrigen `@/`-Zeilen dort sind reine Typen und verschwinden beim Uebersetzen).
// Unter `node` gibt es kein `@/`, also wird es hier auf denselben Pfad gelegt, den auch Vite benutzt.
const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

// Nach dem Haken geladen — statische Importe laufen sonst, bevor er greift.
const ExcelJS = (await import('exceljs')).default;
const { buildCollectionWorkbookBuffer } = await import('../../src/core/media/collection-workbook.ts');
const { decodeImageDataUrl } = await import('../../src/core/media/product-image-export-core.ts');

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

const decNode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
// a real 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const pngBytes = decNode(PNG_B64);

// fixtures: media (empty column, resolver→bytes), legacy (data-url column), missing (nothing), corrupt (resolver throws)
const mk = (id: string, images: string[], extra: Record<string, unknown> = {}) => ({
  id, brand: id, name: id, sku: id, categoryId: 'c', images,
  quantity: 1, purchasePrice: 10, stockStatus: 'in_stock', sourceType: 'OWN', taxScheme: 'VAT_10',
  ...extra,
}) as never;

const items = [
  mk('MEDIAP', []),        // media-pipeline → resolver returns bytes
  mk('LEGACYP', [PNG_URL]), // legacy data-url
  mk('MISSINGP', []),       // no media → resolver returns null
  mk('CORRUPTP', []),       // resolver throws → must be isolated
  // Eine Zeile, deren letztes Stueck verkauft wurde: der Lot-Abgleich schreibt die 0, den Status
  // fasst er nicht an. Sie gehoert in die Liste, aber sie ist kein Stueck und kein Wert mehr.
  mk('EMPTIEDP', [], { quantity: 0 }),
];

const resolveImage = async (product: { id: string; images?: string[] }) => {
  if (product.id === 'MEDIAP') return { bytes: pngBytes, extension: 'png' as const };
  if (product.id === 'CORRUPTP') throw new Error('unreadable blob');
  const legacy = decodeImageDataUrl(product.images?.[0], decNode);
  return legacy; // LEGACYP → decoded png; MISSINGP → null
};

const buf = await buildCollectionWorkbookBuffer(items, {
  lotAgg: new Map(),
  categoryName: () => 'Watches',
  resolveImage,
  scope: { tenantId: 't', branchId: 'b' },
});
check(buf && (buf as ArrayBuffer).byteLength > 0, 'builder returned a non-empty .xlsx buffer');

// Re-open the produced workbook (proves it is a valid, openable .xlsx).
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as ArrayBuffer);
const ws = wb.getWorksheet('Collection');
check(!!ws, 'workbook has the Collection worksheet');

const media = ((wb.model && (wb.model as { media?: Array<{ type: string }> }).media) || []).filter(m => m.type === 'image');
check(media.length === 2, `exactly two images embedded (media + legacy), corrupt/missing skipped (got ${media.length})`);

// all four product rows + header + total row present
const names: string[] = [];
ws!.eachRow(r => { const v = r.getCell(4).value; if (typeof v === 'string') names.push(v); }); // col 4 = Name
check(names.includes('MEDIAP'), 'media product row present');
check(names.includes('LEGACYP'), 'legacy product row present');
check(names.includes('MISSINGP'), 'missing product row present (kept, no image)');
check(names.includes('CORRUPTP'), 'corrupt-image product row present (failure isolated, row kept)');
check(names.some(n => /TOTAL/.test(n)), 'total row present');
check(ws!.rowCount >= 6, `header + 4 products + total (rowCount=${ws!.rowCount})`);

// Die Summenzeile zaehlt Stueck, nicht Zeilen: die geleerte Zeile steht drin und traegt nichts bei.
// Vorher stand hier eine 5 neben einem Wert von 40 — Menge und Wert widersprachen sich.
check(names.includes('EMPTIEDP'), 'the emptied product keeps its row');
let totalQty = null, totalVal = null;
// Spalten über die Kopfzeile finden (die Reihenfolge ist gruppiert, keine festen Nummern mehr).
const colOf = (sheet: typeof ws, header: string): number => { let c = -1; sheet!.getRow(1).eachCell((cell, n) => { if (cell.value === header) c = n; }); return c; };
ws!.eachRow(r => { if (/TOTAL/.test(String(r.getCell(4).value || ''))) { totalQty = r.getCell(colOf(ws, 'Quantity')).value; totalVal = r.getCell(colOf(ws, 'Stock Value (BHD)')).value; } });
check(Number(totalQty) === 4, `the total counts four pieces, not five rows (got ${totalQty})`);
check(Number(totalVal) === 40, `and the value agrees with it (got ${totalVal})`);

// images anchored to the media + legacy rows only (rows 1 and 2, 0-based after header)
const imgs = ws!.getImages();
check(imgs.length === 2, `two anchored images on the sheet (got ${imgs.length})`);
const anchoredRows = imgs.map(im => im.range.tl.nativeRow).sort();
check(anchoredRows[0] === 1 && anchoredRows[1] === 2, `images anchored to the media(row1)+legacy(row2) data rows (got ${anchoredRows})`);

// ── COLLECTIONS-EXPORT — Artikeldetails als Spalten, gruppierte Reihenfolge ─────────────────────────
{
  const { COLLECTION_BASE_HEADERS } = await import('../../src/core/media/collection-workbook.ts');
  const headersOf = (sheet: typeof ws): string[] => { const h: string[] = []; sheet!.getRow(1).eachCell((cell) => { h.push(String(cell.value)); }); return h; };
  const BASE = ['Image', 'SKU', 'Brand', 'Name', 'Category', 'Condition',
    'Supplier', 'Purchase Source', 'Purchase Date', 'Paid From',
    'Purchase Price (BHD)', 'Cost Range (BHD)', 'Stock Value (BHD)', 'Planned Sale Price (BHD)', 'Min Sale (BHD)', 'Max Sale (BHD)', 'Expected Margin (BHD)',
    'Quantity', 'Lots', 'Stock Status', 'Storage Location', 'Days in Stock',
    'Tax Scheme', 'Source Type', 'Notes'];
  check(BASE.length === 25 && JSON.stringify([...COLLECTION_BASE_HEADERS]) === JSON.stringify(BASE), 'die 25 bisherigen Spalten, gruppiert in der festgelegten Reihenfolge');
  check(JSON.stringify(headersOf(ws)) === JSON.stringify(BASE), 'ohne Kategorie-Definitionen: genau die 25 Spalten, keine Detailspalte');

  const attr = (key: string, label: string, type: string, unit?: string) => ({ key, label, type, unit, required: false, showInList: false });
  const categories = [
    { id: 'cat-watch', name: 'Watches', attributes: [
      attr('reference_number', 'Reference', 'text'), attr('serial_number', 'Serial Number', 'text'),
      attr('case_diameter_mm', 'Case Diameter', 'number', 'mm'), attr('material', 'Material', 'select'),
      attr('box', 'Box', 'boolean'), attr('notes', 'Notes', 'text'),                 // „Notes" = Grundspalte → keine zweite
    ] },
    { id: 'cat-gold-jewelry', name: 'Gold-Diamond Jewellery', attributes: [
      attr('item_type', 'Item Type', 'select'), attr('material', 'Material', 'select'),  // gleiche Bezeichnung → eine Spalte
      attr('karat', 'Karat', 'select'), attr('weight', 'Weight', 'number', 'g'), attr('stones', 'Stones', 'stones'),
      attr('size', 'Size', 'text'),                                                   // nirgends ausgefüllt → keine Spalte
    ] },
    { id: 'cat-accessory', name: 'Accessories', attributes: [attr('color', 'Color', 'text'), attr('dimensions', 'Dimensions', 'text')] },
    { id: 'cat-unused', name: 'Unused', attributes: [attr('xyz', 'Never Exported', 'text')] },   // kein Artikel → keine Spalte
  ];
  const art = (id: string, categoryId: string, attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id, brand: 'B-' + id, name: id, sku: id, categoryId, images: [], attributes,
    quantity: 1, purchasePrice: 100, plannedSalePrice: 150, stockStatus: 'in_stock', sourceType: 'OWN', taxScheme: 'MARGIN', ...extra,
  }) as never;
  const items2 = [
    art('WATCH1', 'cat-watch', { reference_number: '126610LN', serial_number: 'S123', case_diameter_mm: 41, material: 'Steel', box: true, notes: 'attr-note' }, { notes: 'echte Notiz' }),
    art('RING1', 'cat-gold-jewelry', { item_type: 'Ring', material: '18K Gold', karat: '18K', weight: '3.10', stones: [{ type: 'diamond', qty: 1, carat: 0.5 }], size: '' }),
    art('BAG1', 'cat-accessory', { color: 'Black', reference_number: 'fremd' }),        // fremder Schlüssel → nicht in „Reference"
    art('WATCH2', 'cat-watch', {}),                                                       // fehlende Felder → leere Zellen
  ];
  const buf2 = await buildCollectionWorkbookBuffer(items2, {
    lotAgg: new Map(), categoryName: (id: string) => categories.find((c) => c.id === id)?.name ?? '',
    resolveImage: async (p: { id: string }) => (p.id === 'RING1' ? { bytes: pngBytes, extension: 'png' as const } : null),
    scope: { tenantId: 't', branchId: 'b' }, categories: categories as never,
  });
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(buf2 as ArrayBuffer);
  const ws2 = wb2.getWorksheet('Collection');
  const h2 = headersOf(ws2);
  const DETAILS = ['Reference', 'Serial Number', 'Case Diameter (mm)', 'Material', 'Box', 'Item Type', 'Karat', 'Weight (g)', 'Stones', 'Color'];
  check(JSON.stringify(h2) === JSON.stringify([...BASE.slice(0, 6), ...DETAILS, ...BASE.slice(6)]),
    `Reihenfolge: Grunddaten · Artikeldetails · Einkauf · Preise · Bestand · Weitere (${h2.join(' | ')})`);
  check(new Set(h2).size === h2.length, 'keine doppelte Spalte (Material einmal, Notes einmal)');
  check(!h2.includes('Size') && !h2.includes('Dimensions') && !h2.includes('Never Exported'), 'keine vollständig leere Zusatzspalte');
  const rowOf = (name: string) => { let r: ExcelJS.Row | undefined; ws2!.eachRow((x) => { if (x.getCell(4).value === name) r = x; }); return r!; };
  const v = (name: string, header: string) => rowOf(name).getCell(h2.indexOf(header) + 1).value;
  check(v('WATCH1', 'Reference') === '126610LN' && v('WATCH1', 'Serial Number') === 'S123' && v('WATCH1', 'Material') === 'Steel' && v('WATCH1', 'Box') === 'Yes', 'Uhr: Referenz, Seriennummer, Material, Box');
  check(v('WATCH1', 'Case Diameter (mm)') === 41 && typeof v('WATCH1', 'Case Diameter (mm)') === 'number', 'Uhr: Durchmesser als Excel-Zahl, Einheit im Kopf');
  check(v('RING1', 'Weight (g)') === 3.1 && typeof v('RING1', 'Weight (g)') === 'number', 'Schmuck: Gewicht als Zahl (auch aus Text „3.10")');
  check(v('RING1', 'Material') === '18K Gold' && v('RING1', 'Karat') === '18K' && v('RING1', 'Item Type') === 'Ring', 'Schmuck: Material in derselben Spalte wie bei der Uhr');
  check(/Diamond 0\.50 ct/.test(String(v('RING1', 'Stones'))), `Schmuck: Steine als Kurzform (${v('RING1', 'Stones')})`);
  check(v('RING1', 'Reference') === null || v('RING1', 'Reference') === '', 'Schmuck: Uhren-Feld bleibt leer (nicht zutreffend)');
  check(v('BAG1', 'Color') === 'Black' && (v('BAG1', 'Reference') === null || v('BAG1', 'Reference') === ''), 'Accessory: Farbe; fremder Schlüssel ohne Definition wird nicht exportiert');
  check(['Reference', 'Serial Number', 'Case Diameter (mm)', 'Material', 'Box'].every((x) => v('WATCH2', x) === null || v('WATCH2', x) === ''), 'fehlende Felder: leere Zellen');
  check(v('WATCH1', 'Notes') === 'echte Notiz', 'Notes ist die Artikelnotiz, nicht ein gleichnamiges Merkmal');
  check(typeof v('WATCH1', 'Purchase Price (BHD)') === 'number' && typeof v('WATCH1', 'Quantity') === 'number' && typeof v('WATCH1', 'Planned Sale Price (BHD)') === 'number', 'Preise und Menge bleiben Excel-Zahlen');
  check(ws2!.getColumn(h2.indexOf('Purchase Price (BHD)') + 1).numFmt === '#,##0.000', 'BHD-Format der Preisspalten erhalten');
  check(ws2!.getImages().length === 1 && ws2!.getImages()[0].range.tl.nativeRow === 2 && ws2!.getImages()[0].range.tl.nativeCol === 0, 'Bild weiterhin in Spalte „Image" der richtigen Zeile');
  let tot: unknown = null; ws2!.eachRow((r) => { if (/TOTAL/.test(String(r.getCell(4).value || ''))) tot = r.getCell(h2.indexOf('Quantity') + 1).value; });
  check(tot === 4, `Summenzeile weiterhin richtig (Menge ${tot})`);
}

if (fail.length) { console.error('EXPORT-I1 workbook: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`EXPORT-I1 workbook: ${pass}/${pass} checks passed`);
