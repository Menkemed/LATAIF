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

// images anchored to the media + legacy rows only (rows 1 and 2, 0-based after header)
const imgs = ws!.getImages();
check(imgs.length === 2, `two anchored images on the sheet (got ${imgs.length})`);
const anchoredRows = imgs.map(im => im.range.tl.nativeRow).sort();
check(anchoredRows[0] === 1 && anchoredRows[1] === 2, `images anchored to the media(row1)+legacy(row2) data rows (got ${anchoredRows})`);

if (fail.length) { console.error('EXPORT-I1 workbook: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`EXPORT-I1 workbook: ${pass}/${pass} checks passed`);
