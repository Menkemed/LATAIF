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
// Je Kategorie ein Blatt (Name = Kategoriename), am Ende „Total".
check(JSON.stringify(wb.worksheets.map((w) => w.name)) === JSON.stringify(['Watches', 'Total']), `Blätter: Kategorie + Total (${wb.worksheets.map((w) => w.name)})`);
const ws = wb.getWorksheet('Watches');
check(!!ws, 'workbook has the category worksheet');

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

// ── COLLECTIONS-EXPORT — Artikeldetails als Spalten, ein Blatt je Kategorie, Blatt „Total" ─────────
{
  const { COLLECTION_BASE_HEADERS, canonicalDetailLabel, REF_MODEL_HEADER } = await import('../../src/core/media/collection-workbook.ts');
  const RM = REF_MODEL_HEADER;
  check(RM === 'Reference / Model No', `gemeinsamer Kopf für Referenz- und Modellnummer (${RM})`);
  const CANON: Array<[string, string]> = [['Serial No', 'Serial Number'], ['Serial No.', 'Serial Number'], ['Serial #', 'Serial Number'], ['serial  nr', 'serial Number'],
    ['Model No', RM], ['Model No.', RM], ['Model #', RM], ['Model Number', RM], ['Ref No', RM], ['Ref.', RM], ['Reference', RM], ['Reference Number', RM],
    ['Model', 'Model'], ['Casino', 'Casino'], ['No', 'No'], ['Item Type', 'Item Type'], ['Piano', 'Piano']];
  const canonBad = CANON.filter(([a, b]) => canonicalDetailLabel(a) !== b);
  check(canonBad.length === 0, `Schreibweisen vereinheitlicht (No/Nr/# → Number; Ref/Model-Nummer → eine Spalte), sonst unverändert (${JSON.stringify(canonBad.map(([a]) => [a, canonicalDetailLabel(a)]))})`);
  const headersOf = (sheet: typeof ws): string[] => { const h: string[] = []; sheet!.getRow(1).eachCell((cell) => { h.push(String(cell.value)); }); return h; };
  const BASE = ['Image', 'SKU', 'Brand', 'Name', 'Category', 'Condition',
    'Supplier', 'Purchase Source', 'Purchase Date', 'Paid From',
    'Purchase Price (BHD)', 'Cost Range (BHD)', 'Stock Value (BHD)', 'Planned Sale Price (BHD)', 'Min Sale (BHD)', 'Max Sale (BHD)', 'Expected Margin (BHD)',
    'Quantity', 'Lots', 'Stock Status', 'Storage Location', 'Days in Stock',
    'Tax Scheme', 'Source Type', 'Notes'];
  const withDetails = (d: string[]) => [...BASE.slice(0, 6), ...d, ...BASE.slice(6)];
  check(BASE.length === 25 && JSON.stringify([...COLLECTION_BASE_HEADERS]) === JSON.stringify(BASE), 'die 25 bisherigen Spalten, gruppiert in der festgelegten Reihenfolge');
  check(JSON.stringify(headersOf(ws)) === JSON.stringify(BASE), 'ohne Kategorie-Definitionen: genau die 25 Spalten, keine Detailspalte');

  const attr = (key: string, label: string, type: string, unit?: string) => ({ key, label, type, unit, required: false, showInList: false });
  const categories = [
    { id: 'cat-watch', name: 'Watches', attributes: [
      attr('reference_number', 'Reference', 'text'), attr('serial_number', 'Serial Number', 'text'),
      attr('case_diameter_mm', 'Case Diameter', 'number', 'mm'), attr('material', 'Material', 'select'),
      attr('model_number', 'Model Number', 'text'),                                   // Ref UND Model in einer Kategorie → beide Werte in einer Zelle
      attr('box', 'Box', 'boolean'), attr('notes', 'Notes', 'text'),                 // „Notes" = Grundspalte → keine zweite
    ] },
    { id: 'cat-gold-jewelry', name: 'Gold-Diamond Jewellery', attributes: [
      attr('item_type', 'Item Type', 'select'), attr('material', 'Material', 'select'),
      attr('karat', 'Karat', 'select'), attr('weight', 'Weight', 'number', 'g'), attr('stones', 'Stones', 'stones'),
      attr('size', 'Size', 'text'),                                                   // nirgends ausgefüllt → keine Spalte
    ] },
    { id: 'cat-accessory', name: 'Accessories', attributes: [attr('color', 'Color', 'text'), attr('serial_no', 'Serial No', 'text'),   // andere Schreibweise → dieselbe Spalte
      attr('serial_number', 'Serial Number', 'text'), attr('model_no', 'Model No.', 'text'), attr('dimensions', 'Dimensions', 'text')] },
    { id: 'cat-unused', name: 'Unused', attributes: [attr('xyz', 'Never Exported', 'text')] },   // kein Artikel → kein Blatt
    { id: 'cat-x', name: 'Straps / Bands: Leather [Extra Long Collection]', attributes: [] },     // unzulässige Zeichen, zu lang
  ];
  const art = (id: string, categoryId: string, attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id, brand: 'B-' + id, name: id, sku: id, categoryId, images: [], attributes,
    quantity: 1, purchasePrice: 100, plannedSalePrice: 150, stockStatus: 'in_stock', sourceType: 'OWN', taxScheme: 'MARGIN', ...extra,
  }) as never;
  const items2 = [
    art('GHOST1', 'cat-ghost', {}),                                                       // Kategorie ohne Definition → Blatt „Other"
    art('WATCH1', 'cat-watch', { reference_number: '126610LN', serial_number: 'S123', case_diameter_mm: 41, material: 'Steel', model_number: 'MN-1', box: true, notes: 'attr-note' }, { notes: 'echte Notiz' }),
    art('RING1', 'cat-gold-jewelry', { item_type: 'Ring', material: '18K Gold', karat: '18K', weight: '3.10', stones: [{ type: 'diamond', qty: 1, carat: 0.5 }], size: '' }),
    // fremder Schlüssel (reference_number) → nicht exportiert; leeres „Serial No" → „Serial Number" derselben Kategorie
    art('BAG1', 'cat-accessory', { color: 'Black', reference_number: 'fremd', serial_no: '', serial_number: 'SN-BAG', model_no: 'M-7' }, { stockStatus: 'sold' }),
    art('STRAP1', 'cat-x', {}),
    art('WATCH2', 'cat-watch', {}, { stockStatus: 'reserved' }),                         // fehlende Felder → leere Zellen
  ];
  const buf2 = await buildCollectionWorkbookBuffer(items2, {
    lotAgg: new Map(), categoryName: (id: string) => categories.find((c) => c.id === id)?.name ?? '',
    resolveImage: async (p: { id: string }) => (p.id === 'RING1' ? { bytes: pngBytes, extension: 'png' as const } : null),
    scope: { tenantId: 't', branchId: 'b' }, categories: categories as never,
  });
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(buf2 as ArrayBuffer);
  const sheetNames = wb2.worksheets.map((w) => w.name);
  const STRAPS = 'Straps Bands Leather Extra Long';
  check(JSON.stringify(sheetNames) === JSON.stringify(['Watches', 'Gold-Diamond Jewellery', 'Accessories', STRAPS, 'Other', 'Total']),
    `ein Blatt je Kategorie in Kategorie-Reihenfolge, Unbekannte als „Other", „Total" am Ende (${sheetNames.join(' | ')})`);
  check(STRAPS.length <= 31 && !/[\\/?*[\]:]/.test(STRAPS), 'Blattname Excel-tauglich (≤ 31 Zeichen, ohne / : [ ])');

  const sh = (name: string) => wb2.getWorksheet(name)!;
  const rowIn = (sheet: string, name: string) => { let r: ExcelJS.Row | undefined; sh(sheet).eachRow((x) => { if (x.getCell(4).value === name) r = x; }); return r; };
  const v = (sheet: string, name: string, header: string) => rowIn(sheet, name)?.getCell(headersOf(sh(sheet)).indexOf(header) + 1).value;
  const leer = (x: unknown) => x === null || x === undefined || x === '';

  const hW = headersOf(sh('Watches'));
  check(JSON.stringify(hW) === JSON.stringify(withDetails([RM, 'Serial Number', 'Case Diameter (mm)', 'Material', 'Box'])),
    `Uhren-Blatt: Ref/Model und Serial vorn nebeneinander, dann Schema-Reihenfolge (${hW.join(' | ')})`);
  check(hW.indexOf('Serial Number') === hW.indexOf(RM) + 1, 'Reference / Model No und Serial Number direkt nebeneinander');
  check(new Set(hW).size === hW.length && !hW.includes('Model Number') && !hW.includes('Reference Number'), 'keine doppelte Spalte (Ref/Model, Notes je einmal)');
  check(v('Watches', 'WATCH1', RM) === '126610LN / MN-1', `Ref UND Model derselben Kategorie: beide Werte bleiben erhalten (${v('Watches', 'WATCH1', RM)})`);
  check(v('Watches', 'WATCH1', 'Serial Number') === 'S123' && v('Watches', 'WATCH1', 'Material') === 'Steel' && v('Watches', 'WATCH1', 'Box') === 'Yes', 'Uhr: Seriennummer, Material, Box');
  check(v('Watches', 'WATCH1', 'Case Diameter (mm)') === 41, 'Uhr: Durchmesser als Excel-Zahl, Einheit im Kopf');
  check([RM, 'Serial Number', 'Case Diameter (mm)', 'Material', 'Box'].every((x) => leer(v('Watches', 'WATCH2', x))), 'fehlende Felder: leere Zellen');
  check(v('Watches', 'WATCH1', 'Notes') === 'echte Notiz', 'Notes ist die Artikelnotiz, nicht ein gleichnamiges Merkmal');
  check(!rowIn('Watches', 'RING1') && !rowIn('Watches', 'BAG1'), 'auf dem Uhren-Blatt nur Uhren');

  const hG = headersOf(sh('Gold-Diamond Jewellery'));
  check(JSON.stringify(hG) === JSON.stringify(withDetails(['Item Type', 'Material', 'Karat', 'Weight (g)', 'Stones'])),
    `Schmuck-Blatt: nur Schmuck-Merkmale, keine leere Uhren-Spalte (${hG.join(' | ')})`);
  check(v('Gold-Diamond Jewellery', 'RING1', 'Weight (g)') === 3.1, 'Schmuck: Gewicht als Zahl (auch aus Text „3.10")');
  check(/Diamond 0\.50 ct/.test(String(v('Gold-Diamond Jewellery', 'RING1', 'Stones'))), 'Schmuck: Steine als Kurzform');
  const gImgs = sh('Gold-Diamond Jewellery').getImages();
  check(gImgs.length === 1 && gImgs[0].range.tl.nativeRow === 1 && gImgs[0].range.tl.nativeCol === 0, 'Bild in Spalte „Image" der richtigen Zeile seines Blatts');
  check(sh('Watches').getImages().length === 0, 'kein fremdes Bild auf anderen Blättern');

  const hA = headersOf(sh('Accessories'));
  check(JSON.stringify(hA) === JSON.stringify(withDetails([RM, 'Serial Number', 'Color'])), `Accessory-Blatt: Model No in der Ref/Model-Spalte (${hA.join(' | ')})`);
  check(v('Accessories', 'BAG1', RM) === 'M-7' && v('Accessories', 'BAG1', 'Serial Number') === 'SN-BAG' && v('Accessories', 'BAG1', 'Color') === 'Black',
    'Accessory: „Model No." → Ref/Model, „Serial No" leer → „Serial Number"; fremder Schlüssel nicht exportiert');
  check(JSON.stringify(headersOf(sh('Other'))) === JSON.stringify(BASE) && !!rowIn('Other', 'GHOST1'), 'Kategorie ohne Definition: Blatt „Other" mit den 25 Spalten');

  // Summenzeilen der Blätter und das Blatt „Total" — dieselbe Regel (eigene Ware, auf Lager).
  const sheetTotal = (sheet: string, header: string) => { let t: unknown = null; sh(sheet).eachRow((r) => { if (/TOTAL/.test(String(r.getCell(4).value || ''))) t = r.getCell(headersOf(sh(sheet)).indexOf(header) + 1).value; }); return t; };
  check(sheetTotal('Watches', 'Quantity') === 1 && sheetTotal('Watches', 'Stock Value (BHD)') === 100, 'Uhren-Summe: nur das Stück auf Lager (reserviert zählt nicht)');
  check(sheetTotal('Accessories', 'Quantity') === 0, 'Accessory-Summe: verkauft zählt nicht');

  const T = sh('Total');
  check(JSON.stringify(headersOf(T)) === JSON.stringify(['Category', 'Items', 'In Stock', 'Sold', 'Other Status', 'Pieces in Stock', 'Stock Value (BHD)', 'Planned Sale Value (BHD)']), `Total-Kopf (${headersOf(T)})`);
  const tRows: Array<{ cat: string; link: string; vals: unknown[] }> = [];
  T.eachRow((r, n) => {
    if (n === 1) return;
    const c = r.getCell(1);
    const link = typeof c.value === 'object' && c.value && 'hyperlink' in c.value ? String((c.value as { hyperlink: string }).hyperlink) : '';
    if (c.text) tRows.push({ cat: c.text, link, vals: [2, 3, 4, 5, 6, 7, 8].map((k) => r.getCell(k).value) });
  });
  const tr = (cat: string) => tRows.find((x) => x.cat === cat);
  check(JSON.stringify(tRows.slice(0, 6).map((x) => x.cat)) === JSON.stringify(['Watches', 'Gold-Diamond Jewellery', 'Accessories', categories[4].name, 'Other', 'TOTAL']),
    `Total: eine Zeile je Kategorie, dann TOTAL (${tRows.map((x) => x.cat).join(' | ')})`);
  check(JSON.stringify(tr('Watches')?.vals) === JSON.stringify([2, 1, 0, 1, 1, 100, 150]), `Total Uhren: 2 Artikel, 1 auf Lager, 1 anderer Status (${JSON.stringify(tr('Watches')?.vals)})`);
  check(JSON.stringify(tr('Accessories')?.vals) === JSON.stringify([1, 0, 1, 0, 0, 0, 0]), `Total Accessory: 1 verkauft, kein Lagerwert (${JSON.stringify(tr('Accessories')?.vals)})`);
  check(JSON.stringify(tr('TOTAL')?.vals) === JSON.stringify([6, 4, 1, 1, 4, 400, 600]), `Gesamtsumme (${JSON.stringify(tr('TOTAL')?.vals)})`);
  const sumSheets = ['Watches', 'Gold-Diamond Jewellery', 'Accessories', STRAPS, 'Other'].reduce((s, n) => s + Number(sheetTotal(n, 'Stock Value (BHD)') || 0), 0);
  check(sumSheets === 400, `Total = Summe der Summenzeilen aller Blätter (${sumSheets})`);
  check(tr('Watches')?.link === "#'Watches'!A1" && tr(categories[4].name)?.link === `#'${STRAPS}'!A1`, `Kategorie-Zeile springt zum Blatt (${tr('Watches')?.link})`);
  check(T.getColumn(7).numFmt === '#,##0.000', 'BHD-Format im Total-Blatt');
}

if (fail.length) { console.error('EXPORT-I1 workbook: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`EXPORT-I1 workbook: ${pass}/${pass} checks passed`);
