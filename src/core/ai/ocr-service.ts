// Lazy-loaded OCR via tesseract.js. Runs fully offline, no API needed.
// English + Arabic support (best effort — photo quality matters).

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
 * Extract text from an image (data URL or File/Blob).
 * Returns empty result if input is not an image.
 */
export async function runOcr(input: string | File | Blob, lang: string = 'eng+ara'): Promise<OcrResult> {
  // Filter: only attempt OCR on images
  if (input instanceof Blob && !input.type.startsWith('image/')) {
    return { text: '', confidence: 0 };
  }
  if (typeof input === 'string') {
    // data URL check
    if (!input.startsWith('data:image/')) return { text: '', confidence: 0 };
  }

  const tesseract = await getTesseract();
  const result = await tesseract.recognize(input as never, lang);
  return {
    text: result.data.text?.trim() || '',
    confidence: result.data.confidence || 0,
  };
}

export function isOcrSupported(file: { fileType?: string } | { fileType: string | undefined }): boolean {
  const type = (file as { fileType?: string }).fileType || '';
  return type.startsWith('image/');
}
