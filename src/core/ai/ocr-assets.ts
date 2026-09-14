// The OCR files ship WITH the app — nothing is loaded from a CDN at runtime.
//
// tesseract.js loads its worker, its engine core and the language data from cdn.jsdelivr.net unless
// told otherwise. The app's CSP (`script-src 'self' 'wasm-unsafe-eval'`, src-tauri/tauri.conf.json)
// blocks those scripts, so OCR never ran in the app. `vite.config.ts` serves the files below in dev and
// writes them to `dist/ocr/` for the build; `ocr-service.ts` points tesseract.js at them.
//
// Pure module (no app imports): `vite.config.ts` reads it too.

/** Where the app serves the OCR files — the page's own origin. */
export const OCR_BASE = '/ocr/';

/** The languages OCR has always used (English + Arabic). Only these are shipped. */
export const OCR_LANGS = ['eng', 'ara'] as const;

/** The worker entry: allows same-origin loads only, then starts tesseract's worker (`ocr-worker-entry.js`). */
export const OCR_WORKER = 'ocr-worker.js';

/**
 * The engine core. `createWorker` uses the LSTM engine (OEM 1), so the LSTM-only core is enough; the
 * SIMD build runs on every WebView2. A path ending in `.js` makes tesseract.js load exactly this file.
 */
export const OCR_CORE = 'tesseract-core-simd-lstm.wasm.js';

/**
 * Published file name → source, relative to the project root. The language data is the set tesseract.js
 * fetched for the LSTM engine before (`4.0.0_best_int`), now from the pinned `@tesseract.js-data` packages.
 */
export const OCR_FILES: Readonly<Record<string, string>> = {
  [OCR_WORKER]: 'src/core/ai/ocr-worker-entry.js',
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  [OCR_CORE]: `node_modules/tesseract.js-core/${OCR_CORE}`,
  'eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  'ara.traineddata.gz': 'node_modules/@tesseract.js-data/ara/4.0.0_best_int/ara.traineddata.gz',
};
