// Lazy-loaded OCR via tesseract.js. Runs fully offline, no API needed.
// English + Arabic support (best effort — photo quality matters).
// Worker, engine core and language data ship with the app (`ocr-assets.ts`) — no CDN.

import { OCR_BASE, OCR_CORE, OCR_LANGS, OCR_WORKER } from './ocr-assets';

type TesseractModule = typeof import('tesseract.js');

let modPromise: Promise<TesseractModule> | null = null;

async function getTesseract(): Promise<TesseractModule> {
  if (!modPromise) {
    modPromise = import('tesseract.js');
  }
  return modPromise;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

/**
 * tesseract.js options: every file from the app's own origin, none of its CDN defaults. The worker is
 * started from its URL (not a blob), so its same-origin guard applies; no IndexedDB copy of the
 * language data — the app's files are the only source.
 */
export function ocrWorkerOptions(base: string = OCR_BASE) {
  return {
    workerPath: `${base}${OCR_WORKER}`,
    corePath: `${base}${OCR_CORE}`,
    langPath: base.replace(/\/$/, ''),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
  };
}

/**
 * POST-PARITY R7B PP-12 — höchstens so viele Bildpunkte bekommt die Erkennung (≈ 4000 × 3000, ein
 * Handyfoto). Mehr macht Text nicht lesbarer, nur die Erkennung länger — und sie hält am Primary
 * die exklusive Schreibspur. Mit der Grenze hat der längste Fall eine obere Schranke, aus der die
 * Frist des Fernbefehls abgeleitet ist (`bridge.rs` `OCR_MAX_PIXELS`, derselbe Wert).
 */
export const OCR_MAX_PIXELS = 12_000_000;

/** Die Größe, in der ein Bild erkannt wird: unverändert bis zur Grenze, sonst maßstabsgleich darunter. */
export function ocrTargetSize(width: number, height: number, max = OCR_MAX_PIXELS): { width: number; height: number; scaled: boolean } {
  if (!(width > 0) || !(height > 0) || width * height <= max) return { width, height, scaled: false };
  const f = Math.sqrt(max / (width * height));
  return { width: Math.max(1, Math.floor(width * f)), height: Math.max(1, Math.floor(height * f)), scaled: true };
}

/** Ein großes Bild vor der Erkennung verkleinern (im Fenster; ohne Leinwand bleibt es unverändert). */
async function boundedOcrInput(input: string | File | Blob): Promise<string | Blob> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return input;
  let blob: Blob;
  if (typeof input === 'string') {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(input);
    if (!m) return input;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: m[1] });
  } else {
    blob = input;
  }
  const bmp = await createImageBitmap(blob);
  try {
    const t = ocrTargetSize(bmp.width, bmp.height);
    if (!t.scaled) return input;
    const canvas = new OffscreenCanvas(t.width, t.height);
    const g = canvas.getContext('2d');
    if (!g) return input;
    g.drawImage(bmp, 0, 0, t.width, t.height);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bmp.close();
  }
}

/**
 * Extract text from an image (data URL or File/Blob).
 * Returns empty result if input is not an image.
 */
export async function runOcr(input: string | File | Blob): Promise<OcrResult> {
  // Filter: only attempt OCR on images
  if (input instanceof Blob && !input.type.startsWith('image/')) {
    return { text: '', confidence: 0 };
  }
  if (typeof input === 'string') {
    // data URL check
    if (!input.startsWith('data:image/')) return { text: '', confidence: 0 };
  }

  const tesseract = await getTesseract();
  const bounded = await boundedOcrInput(input).catch(() => input);
  const result = await tesseract.recognize(bounded as never, OCR_LANGS.join('+'), ocrWorkerOptions());
  return {
    text: result.data.text?.trim() || '',
    confidence: result.data.confidence || 0,
  };
}

export function isOcrSupported(file: { fileType?: string } | { fileType: string | undefined }): boolean {
  const type = (file as { fileType?: string }).fileType || '';
  return type.startsWith('image/');
}
