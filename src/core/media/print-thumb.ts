// Kleines Druckbild: ein aufgelöstes Produktbild (Bytes) → verkleinerte JPEG-data:-URL für den Listen-Druck.
// Im Browser/WebView über createImageBitmap + Canvas; geht das nicht, das Original als data:-URL.
import type { ExportImage } from '@/core/media/product-image-export-core';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Längste Kante höchstens `maxPx` (Standard 240 px ≈ 13 mm bei Druckauflösung, scharf genug). */
export async function printThumbDataUrl(img: ExportImage, maxPx = 240): Promise<string> {
  const mime = img.extension === 'png' ? 'image/png' : 'image/jpeg';
  try {
    const bmp = await createImageBitmap(new Blob([img.bytes as unknown as BlobPart], { type: mime }));
    const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return `data:${mime};base64,${toBase64(img.bytes)}`;
  }
}
