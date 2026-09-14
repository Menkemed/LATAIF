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
  const result = await tesseract.recognize(input as never, OCR_LANGS.join('+'), ocrWorkerOptions());
  return {
    text: result.data.text?.trim() || '',
    confidence: result.data.confidence || 0,
  };
}

export function isOcrSupported(file: { fileType?: string } | { fileType: string | undefined }): boolean {
  const type = (file as { fileType?: string }).fileType || '';
  return type.startsWith('image/');
}
