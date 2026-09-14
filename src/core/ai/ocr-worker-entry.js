// OCR worker entry, served by the app as /ocr/ocr-worker.js (see ocr-assets.ts).
//
// It starts tesseract's worker from the same folder and allows ONLY same-origin loads: the engine core
// and the language data come with the app. The page's CSP already blocks foreign scripts, but its
// `connect-src` allows https: for other features, so a fetch of language data from the tesseract.js
// default CDN would still leave the computer. Here it fails loudly instead.
(() => {
  const own = self.location.origin;
  const sameOrigin = (u) => new URL(String(u), self.location.href).origin === own;
  const refused = (u) => new TypeError(`OCR_OFFLINE_ONLY: refused ${String(u)}`);

  const nativeFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = input && typeof input === 'object' && 'url' in input ? input.url : input;
    return sameOrigin(url) ? nativeFetch(input, init) : Promise.reject(refused(url));
  };

  const nativeImport = self.importScripts.bind(self);
  self.importScripts = (...urls) => {
    for (const u of urls) if (!sameOrigin(u)) throw refused(u);
    return nativeImport(...urls);
  };

  self.importScripts('./worker.min.js');
})();
