// ═══════════════════════════════════════════════════════════
// LATAIF — Hangtag / Price Tag Generator
// Small label with barcode for product tagging
// ═══════════════════════════════════════════════════════════

import JsBarcode from 'jsbarcode';

interface HangtagData {
  sku: string;          // Line 1: Serial Tag / SKU (barcode value)
  brand: string;        // Line 2: Brand abbreviation
  price: number;        // Line 3: Price
  currency: string;     // Line 3: Currency (BD, BHD)
  name: string;         // Line 4: Model / Name
  material?: string;    // Line 5: Material / Metal
  size?: string;        // Line 6: Size
  description?: string; // Line 7: Extra description
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) : s;
}

function generateBarcodeDataUrl(value: string): string {
  const canvas = document.createElement('canvas');
  try {
    JsBarcode(canvas, value, {
      format: 'CODE128',
      width: 1.5,
      height: 30,
      displayValue: false,
      margin: 0,
    });
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}

function printViaIframe(html: string): void {
  const existing = document.getElementById('lataif-print-frame');
  if (existing) existing.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'lataif-print-frame';
  iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:0;height:0;border:none;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();

  setTimeout(() => {
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 300);
}

export function printHangtag(data: HangtagData): void {
  const barcodeUrl = generateBarcodeDataUrl(data.sku || 'NOSKU');
  const lines: string[] = [];

  lines.push(truncate(data.sku || '', 16));
  lines.push(truncate(data.brand || '', 16));
  lines.push(`${data.currency === 'BHD' ? 'BD' : data.currency}  ${Math.round(data.price)}`);
  if (data.name) lines.push(truncate(data.name.toUpperCase(), 16));
  if (data.material) lines.push(truncate(data.material.toUpperCase(), 16));
  if (data.size) lines.push(truncate(data.size.toUpperCase(), 16));
  if (data.description) lines.push(truncate(data.description.toUpperCase(), 16));

  const linesHtml = lines.map(l => `<div class="tag-line">${l}</div>`).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Hangtag</title>
<style>
  @page { size: 40mm 60mm; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 40mm; height: 60mm; font-family: 'Courier New', monospace; font-size: 8pt; display: flex; flex-direction: column; align-items: center; padding: 2mm; background: #fff; color: #000; }
  .tag-barcode { width: 36mm; height: 8mm; margin-bottom: 1.5mm; display: flex; align-items: center; justify-content: center; }
  .tag-barcode img { max-width: 100%; max-height: 100%; }
  .tag-lines { width: 36mm; display: flex; flex-direction: column; gap: 0.5mm; }
  .tag-line { font-size: 8pt; line-height: 1.2; letter-spacing: 0.5pt; white-space: nowrap; overflow: hidden; font-weight: 700; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style>
</head><body>
  <div class="tag-barcode">${barcodeUrl ? `<img src="${barcodeUrl}" alt="barcode" />` : ''}</div>
  <div class="tag-lines">${linesHtml}</div>
</body></html>`;

  printViaIframe(html);
}

export function printMultipleHangtags(tags: HangtagData[]): void {
  const pages = tags.map(data => {
    const barcodeUrl = generateBarcodeDataUrl(data.sku || 'NOSKU');
    const lines: string[] = [];
    lines.push(truncate(data.sku || '', 16));
    lines.push(truncate(data.brand || '', 16));
    lines.push(`${data.currency === 'BHD' ? 'BD' : data.currency}  ${Math.round(data.price)}`);
    if (data.name) lines.push(truncate(data.name.toUpperCase(), 16));
    if (data.material) lines.push(truncate(data.material.toUpperCase(), 16));
    if (data.size) lines.push(truncate(data.size.toUpperCase(), 16));
    if (data.description) lines.push(truncate(data.description.toUpperCase(), 16));
    const linesHtml = lines.map(l => `<div class="tag-line">${l}</div>`).join('');
    return `<div class="tag"><div class="tag-barcode">${barcodeUrl ? `<img src="${barcodeUrl}" />` : ''}</div><div class="tag-lines">${linesHtml}</div></div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Hangtags</title>
<style>
  @page { size: 40mm 60mm; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Courier New', monospace; font-size: 8pt; color: #000; background: #fff; }
  .tag { width: 40mm; height: 60mm; display: flex; flex-direction: column; align-items: center; padding: 2mm; page-break-after: always; }
  .tag:last-child { page-break-after: auto; }
  .tag-barcode { width: 36mm; height: 8mm; margin-bottom: 1.5mm; display: flex; align-items: center; justify-content: center; }
  .tag-barcode img { max-width: 100%; max-height: 100%; }
  .tag-lines { width: 36mm; display: flex; flex-direction: column; gap: 0.5mm; }
  .tag-line { font-size: 8pt; line-height: 1.2; letter-spacing: 0.5pt; white-space: nowrap; overflow: hidden; font-weight: 700; }
</style>
</head><body>${pages}</body></html>`;

  printViaIframe(html);
}
