// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F FINAL — die Texterkennung läuft offline: Worker, Engine-Kern und Sprachdaten
// kommen mit der App, nichts vom CDN. Der Laufzeitbeweis (Primary + PC2, echte Erkennung, kein
// CDN-Request) steht im Zwei-Rechner-Lauf; hier der Vertrag der Dateien und Optionen.
// Run: node test/r6f/ocr-offline.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import vm from 'node:vm';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const assets = await import('../../src/core/ai/ocr-assets.ts');
const svc = await import('../../src/core/ai/ocr-service.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);

// ── §1 Die Dateien ──────────────────────────────────────────────────────────
{
  const files = Object.entries(assets.OCR_FILES);
  let total = 0;
  for (const [name, from] of files) {
    const p = resolvePath(repo, from);
    const size = existsSync(p) ? statSync(p).size : 0;
    total += size;
    ok(size > 0, `FILES ${name} ← ${from} (${size} B)`);
  }
  ok(S(files.map(([n]) => n).sort()) === S(['ara.traineddata.gz', 'eng.traineddata.gz', 'ocr-worker.js', 'tesseract-core-simd-lstm.wasm.js', 'worker.min.js']),
    'FILES genau Worker-Eingang, Worker, Kern und die zwei Sprachen');
  ok(S([...assets.OCR_LANGS]) === S(['eng', 'ara']) && assets.OCR_LANGS.every((l) => assets.OCR_FILES[`${l}.traineddata.gz`]?.includes(`/${l}/4.0.0_best_int/`)),
    'FILES nur die Sprachen, die OCR schon immer nutzte (eng+ara) — die LSTM-Daten, die tesseract.js vorher vom CDN holte (4.0.0_best_int)');
  const gz = (l: string): boolean => { const b = readFileSync(resolvePath(repo, assets.OCR_FILES[`${l}.traineddata.gz`])); return b[0] === 0x1f && b[1] === 0x8b; };
  ok(gz('eng') && gz('ara'), 'FILES die Sprachdaten sind gzip (tesseract.js entpackt sie selbst)');
  const pkg = JSON.parse(src('package.json')) as { dependencies: Record<string, string> };
  ok(pkg.dependencies['@tesseract.js-data/eng'] === '1.0.0' && pkg.dependencies['@tesseract.js-data/ara'] === '1.0.0',
    'FILES die Sprachpakete sind exakt gepinnt (1.0.0)');
  const core = JSON.parse(src('node_modules/tesseract.js-core/package.json')) as { version: string };
  const tjs = JSON.parse(src('node_modules/tesseract.js/package.json')) as { version: string; dependencies: Record<string, string> };
  ok(tjs.dependencies['tesseract.js-core'].replace(/^\^/, '').split('.')[0] === core.version.split('.')[0],
    `FILES der Kern passt zu tesseract.js (${tjs.version} ↔ core ${core.version})`);
  console.log(`  i OCR-Dateien zusammen ${total} B (${(total / 1048576).toFixed(2)} MiB) — so viel mehr trägt die App`);
}

// ── §2 Die Optionen: jede CDN-Vorgabe von tesseract.js ist überschrieben ─────
{
  const o = svc.ocrWorkerOptions();
  ok(o.workerPath === '/ocr/ocr-worker.js' && o.corePath === '/ocr/tesseract-core-simd-lstm.wasm.js' && o.langPath === '/ocr',
    `OPTIONS Worker, Kern, Sprachen vom eigenen Ursprung (${S(o)})`);
  ok(!/https?:|\/\//.test(S([o.workerPath, o.corePath, o.langPath])), 'OPTIONS kein Host in einem Pfad — immer der Ursprung der Seite');
  ok(o.workerBlobURL === false && o.cacheMethod === 'none' && o.gzip === true,
    'OPTIONS Worker aus seiner URL (kein Blob: sein Wächter gilt), keine IndexedDB-Kopie, gzip-Daten');
  // Wo tesseract.js ohne diese Optionen hinginge — jede Stelle bekommt ihren Wert.
  const defs = src('node_modules/tesseract.js/src/worker/browser/defaultOptions.js');
  const getCore = src('node_modules/tesseract.js/src/worker-script/browser/getCore.js');
  const ws = src('node_modules/tesseract.js/src/worker-script/index.js');
  ok(/workerPath: `https:\/\/cdn\.jsdelivr\.net/.test(defs) && /corePath \|\| `https:\/\/cdn\.jsdelivr\.net/.test(getCore) && /langPath \|\| \(lstmOnly \? `https:\/\/cdn\.jsdelivr\.net/.test(ws),
    'OPTIONS die drei CDN-Vorgaben von tesseract.js (Worker, Kern, Sprachen) — genau die drei, die gesetzt sind');
  ok(/if \(corePathImport\.slice\(-2\) === 'js'\) \{\s*corePathImportFile = corePathImport;/.test(getCore),
    'OPTIONS ein Kernpfad auf .js lädt genau diese Datei (keine Auswahl im CDN-Verzeichnis)');
  const code = codeOf(src('src/core/ai/ocr-service.ts'));
  ok(/tesseract\.recognize\(input as never, OCR_LANGS\.join\('\+'\), ocrWorkerOptions\(\)\)/.test(code) && !/cdn|jsdelivr|https?:/i.test(code),
    'OPTIONS runOcr erkennt mit genau diesen Optionen und den ausgelieferten Sprachen');
  const dh = codeOf(src('src/core/office/document-house.ts'));
  ok(/defaultOcrEngine: OcrEngine = async \(dataUrl\) => \(await import\('@\/core\/ai\/ocr-service'\)\)\.runOcr\(dataUrl\)/.test(dh),
    'OPTIONS documents.set_ocr (Primary und PC2) erkennt über diesen Weg — am Primary');
}

// ── §3 Der Wächter im Worker: nur derselbe Ursprung ─────────────────────────
{
  const calls: string[] = [];
  const own = 'http://tauri.localhost';
  const ctx: Record<string, unknown> = {
    URL, TypeError, Promise,
    location: new URL(`${own}/ocr/ocr-worker.js`),
    fetch: (u: unknown) => { calls.push('fetch ' + String((u as { url?: string })?.url ?? u)); return Promise.resolve('ok'); },
    importScripts: (...u: unknown[]) => { calls.push('import ' + u.map((x) => new URL(String(x), `${own}/ocr/ocr-worker.js`).href).join(',')); },
  };
  ctx.self = ctx;
  vm.runInNewContext(src('src/core/ai/ocr-worker-entry.js'), ctx);
  ok(S(calls) === S([`import ${own}/ocr/worker.min.js`]), `GUARD der Eingang startet tesseracts Worker aus demselben Ordner (${S(calls)})`);
  const self = ctx as { fetch: (u: unknown) => Promise<unknown>; importScripts: (...u: string[]) => void };
  const cdnData = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
  const cdnCore = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v7.0.0/tesseract-core-simd-lstm.wasm.js';
  const abgewiesen = async (p: () => Promise<unknown>): Promise<string> => { try { await p(); return 'durch'; } catch (e) { return String((e as Error).message); } };
  const f1 = await abgewiesen(() => self.fetch(cdnData));
  const f2 = await abgewiesen(() => self.fetch({ url: cdnData }));
  const f3 = await abgewiesen(() => self.fetch('/ocr/eng.traineddata.gz'));
  let i1 = ''; try { self.importScripts(cdnCore); } catch (e) { i1 = (e as Error).message; }
  self.importScripts(`${own}/ocr/tesseract-core-simd-lstm.wasm.js`);
  ok(f1.startsWith('OCR_OFFLINE_ONLY') && f2.startsWith('OCR_OFFLINE_ONLY') && i1.startsWith('OCR_OFFLINE_ONLY'),
    `GUARD Sprachdaten oder Kern vom CDN → abgewiesen, bevor etwas das Haus verlässt (${S([f1, i1])})`);
  ok(f3 === 'durch' && calls.includes('fetch /ocr/eng.traineddata.gz') && calls.includes(`import ${own}/ocr/tesseract-core-simd-lstm.wasm.js`)
    && !calls.some((c) => c.includes('jsdelivr')), `GUARD eigene Dateien gehen durch; der CDN wurde nie gefragt (${S(calls)})`);
}

// ── §4 Auslieferung und Sicherheitsrichtlinie ───────────────────────────────
{
  const vc = codeOf(src('vite.config.ts'));
  ok(/plugins: \[react\(\), tailwindcss\(\), ocrAssets\(\)\]/.test(vc) && /this\.emitFile\(\{ type: 'asset', fileName: OCR_BASE\.slice\(1\) \+ name, source: source\(name\) \}\)/.test(vc)
    && /server\.middlewares\.use\(/.test(vc), 'SHIP vite liefert jede OCR-Datei aus: im Build nach dist/ocr/, in der Entwicklung unter /ocr/');
  const csp = (JSON.parse(src('src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } }).app.security.csp;
  ok(/script-src 'self' 'wasm-unsafe-eval';/.test(csp) && /worker-src 'self' blob:;/.test(csp) && !/jsdelivr|unpkg|cdn/i.test(csp),
    'CSP unverändert: Skripte und Worker nur vom eigenen Ursprung — keine Aufweichung für einen CDN');
  const dist = resolvePath(repo, 'dist', 'ocr');
  if (existsSync(dist)) {
    const gleich = Object.entries(assets.OCR_FILES).every(([name, from]) => existsSync(resolvePath(dist, name))
      && readFileSync(resolvePath(dist, name)).equals(readFileSync(resolvePath(repo, from))));
    ok(gleich, 'SHIP dist/ocr/ enthält jede Datei bytegleich zur Quelle');
  } else {
    console.log('  i dist/ocr/ noch nicht gebaut — der Byte-Vergleich läuft nach dem Build');
  }
  const dl = src('src/pages/documents/DocumentList.tsx');
  ok(!/downloads ~3 MB/.test(dl) && /data-ocr-error/.test(dl), 'UI kein Versprechen eines Downloads mehr; die Absage der Erkennung ist erkennbar (data-ocr-error)');
}

if (fails.length === 0) console.log('CENTRAL_UI_R6F_OCR_OFFLINE_ASSETS_PINNED');
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r6f ocr offline: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
