// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C3-R3 — central provider adapter + repository-wide bypass gate.
// Run: node test/media04a3b2c3r3/adapter-and-bypass-gate.test.ts
//
// Proves: (1) the pure adapter core resolves→calls→normalizes without leaking
// image data and honours blocking/text-only/error paths; (2) a repository-wide
// static gate that the RAW identifyProduct provider is imported/called in EXACTLY
// one adapter file, failing on every bypass shape; (3) all 5 sites use the
// adapter; (4) validation error → provider never called; (5) identical retry →
// identical frozen hash; (6) call-site stale guards still present.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { runIdentifyFromResolvedInput, normalizeProviderError, type ResolvedAiInput } from '../../src/core/ai/identify-adapter-core.ts';
import { validateEphemeralImage } from '../../src/core/media/ai-image-source.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  x ${m}`); } }

const hashBytes = async (b: Uint8Array) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const decodeBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64.replace(/\s/g, ''), 'base64'));
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  b[16] = (w >>> 24) & 0xff; b[17] = (w >>> 16) & 0xff; b[18] = (w >>> 8) & 0xff; b[19] = w & 0xff;
  b[20] = (h >>> 24) & 0xff; b[21] = (h >>> 16) & 0xff; b[22] = (h >>> 8) & 0xff; b[23] = h & 0xff;
  return b;
}
function dataUrl(mime: string, bytes: Uint8Array): string { return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`; }

// Strip block + line comments so a mention of the token in prose is not a call.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const RAW = /\bidentifyProduct\b/; // does NOT match identifyProductFromResolvedInput (\b before 'F' fails)

async function main(): Promise<void> {
  // ── 1. adapter core: blocking / text-only / success / error ────────────────
  const goodInput: ResolvedAiInput = { ok: true, dataUrl: 'data:image/png;base64,AAAA', source: { kind: 'ephemeral_new', clientId: 'c', mime: 'image/png', hash: 'h1' } };
  {
    let called = 0; let seenImage: string | undefined = 'SENTINEL';
    const provider = async (p: { imageBase64?: string }) => { called++; seenImage = p.imageBase64; return { brand: 'X' }; };
    const r = await runIdentifyFromResolvedInput({ categoryId: 'cat-watch' }, goodInput, provider);
    ok(r.ok && called === 1 && seenImage === 'data:image/png;base64,AAAA', 'ok input → provider called once with resolved data URL');
    ok(r.ok && r.usedImage === true && r.source?.kind === 'ephemeral_new', 'success carries frozen source + usedImage');
  }
  {
    // BLOCKING failure → provider NEVER called.
    let called = 0;
    const provider = async () => { called++; return { brand: 'X' }; };
    const blocked: ResolvedAiInput = { ok: false, error: 'MEDIA_AI_OBJECT_URL_REJECTED', blocking: true };
    const r = await runIdentifyFromResolvedInput({ categoryId: 'cat-watch' }, blocked, provider);
    ok(!r.ok && called === 0 && (r as { blocking: boolean }).blocking === true, 'blocking resolver failure → provider NEVER called');
  }
  {
    // NON-blocking (no usable image) → text-only call, imageBase64 undefined.
    let seenImage: string | undefined = 'SENTINEL'; let called = 0;
    const provider = async (p: { imageBase64?: string }) => { called++; seenImage = p.imageBase64; return { brand: 'T' }; };
    const noImg: ResolvedAiInput = { ok: false, error: 'MEDIA_AI_NO_IMAGE', blocking: false };
    const r = await runIdentifyFromResolvedInput({ categoryId: 'cat-watch' }, noImg, provider);
    ok(r.ok && called === 1 && seenImage === undefined && r.usedImage === false && r.source === null, 'non-blocking no-image → text-only call, usedImage false');
  }
  {
    // provider throw → normalized, blocking, no leak of image data.
    const provider = async () => { throw new Error('rate limit; base64 data:image/png;base64,SECRETLEAK'); };
    const r = await runIdentifyFromResolvedInput({ categoryId: 'cat-watch' }, goodInput, provider);
    ok(!r.ok && (r as { blocking: boolean }).blocking === true, 'provider throw → ok:false blocking');
    // normalized message keeps the provider text but the adapter never logs the image;
    // the resolved data URL is not part of the error object.
    ok(!r.ok && !(r as { error: string }).error.includes('AAAA'), 'error message does not contain the resolved image bytes');
  }
  ok(normalizeProviderError({ message: '   ' }) === 'MEDIA_AI_PROVIDER_ERROR', 'empty message → generic code');
  ok(normalizeProviderError('boom') === 'boom', 'string error passthrough');

  // ── 5. identical retry → identical frozen hash ─────────────────────────────
  const url = dataUrl('image/png', png(120, 90));
  const v1 = await validateEphemeralImage(url, 'ai:new', { decodeBase64, hashBytes });
  const v2 = await validateEphemeralImage(url, 'ai:new', { decodeBase64, hashBytes });
  ok(v1.ok && v2.ok && v1.source.hash === v2.source.hash, 'identical input → identical frozen hash (idempotent retry)');
  {
    // and the adapter passes that frozen source straight through.
    const resolved: ResolvedAiInput = v1.ok ? { ok: true, dataUrl: url, source: v1.source } : { ok: false, error: 'x', blocking: true };
    const r = await runIdentifyFromResolvedInput({ categoryId: 'cat-watch' }, resolved, async () => ({ brand: 'Y' }));
    ok(r.ok && v1.ok && r.source?.kind === 'ephemeral_new' && r.source.hash === v1.source.hash, 'adapter forwards the frozen hash unchanged');
  }

  // ── 2/3. repository-wide bypass gate ───────────────────────────────────────
  const ADAPTER = 'src/core/ai/identify-adapter.ts';   // only importer/caller
  const DEFINER = 'src/core/ai/ai-service.ts';         // provider definition
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const files = walk(SRC);
  ok(files.length > 50, `scanned productive src tree (${files.length} files)`);
  const offenders: string[] = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (rel === ADAPTER || rel === DEFINER) continue;
    const code = stripComments(readFileSync(abs, 'utf8'));
    if (RAW.test(code)) offenders.push(rel);
  }
  ok(offenders.length === 0, `no productive file outside the adapter references the raw provider${offenders.length ? ' → ' + offenders.join(', ') : ''}`);

  // adapter file really imports + calls the raw provider.
  const adapterSrc = stripComments(readFileSync(join(ROOT, ADAPTER), 'utf8'));
  ok(/import\s*\{[^}]*\bidentifyProduct\b[^}]*\}\s*from\s*['"]\.\/ai-service['"]/.test(adapterSrc), 'adapter imports raw identifyProduct from ai-service');
  ok((adapterSrc.match(/\bidentifyProduct\b/g) || []).length >= 2, 'adapter both imports and uses the raw provider');
  // definer only DEFINES it (no import/call of a foreign one).
  const defSrc = stripComments(readFileSync(join(ROOT, DEFINER), 'utf8'));
  ok(/export\s+async\s+function\s+identifyProduct\b/.test(defSrc), 'ai-service defines the provider');

  // all 5 sites use the adapter and NOT the raw provider.
  const SITES = [
    'src/pages/watches/ProductDetail.tsx',
    'src/pages/watches/WatchList.tsx',
    'src/pages/consignments/ConsignmentList.tsx',
    'src/components/products/NewProductModal.tsx',
    'src/components/sync/SyncDuplicateGuard.tsx',
  ];
  for (const rel of SITES) {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    ok(code.includes('identifyProductFromResolvedInput'), `${rel}: uses the central adapter`);
    ok(!RAW.test(code), `${rel}: no raw identifyProduct reference`);
  }
  // ── 6. call-site stale/supersession/target guards still present ────────────
  const pd = readFileSync(join(ROOT, 'src/pages/watches/ProductDetail.tsx'), 'utf8');
  ok(pd.includes('aiReqRef.current !== myReq') && pd.includes('aiImgRef.current !== frozenImg'), 'ProductDetail stale guard intact');
  const sg = readFileSync(join(ROOT, 'src/components/sync/SyncDuplicateGuard.tsx'), 'utf8');
  ok(sg.includes('shouldApplySyncAutoIdentify'), 'SyncDuplicateGuard target guard intact');
  for (const rel of ['src/pages/watches/WatchList.tsx', 'src/pages/consignments/ConsignmentList.tsx', 'src/components/products/NewProductModal.tsx']) {
    ok(readFileSync(join(ROOT, rel), 'utf8').includes('shouldApplyEphemeralResult'), `${rel}: ephemeral stale guard intact`);
  }

  // ── gate NEGATIVES: every bypass shape must be detected ────────────────────
  const bypasses: Array<[string, string]> = [
    ['direct component usage', `const r = await identifyProduct({ categoryId });`],
    ['named import', `import { identifyProduct } from '@/core/ai/ai-service';`],
    ['alias import', `import { identifyProduct as idp } from '@/core/ai/ai-service';`],
    ['namespace call', `const ai = await import('@/core/ai/ai-service'); const r = ai.identifyProduct({});`],
    ['renamed raw-image var', `const rawImg = form.images[0]; const r = await identifyProduct({ imageBase64: rawImg });`],
    ['sixth call site', `function SixthSite(){ return identifyProduct({}); }`],
  ];
  for (const [label, snippet] of bypasses) {
    ok(RAW.test(stripComments(snippet)), `gate detects bypass: ${label}`);
  }
  // the sanctioned adapter call must NOT be flagged as a raw usage.
  ok(!RAW.test(stripComments(`const r = await identifyProductFromResolvedInput({ productId, formImage0 });`)), 'sanctioned adapter call not flagged');
  // a prose mention in a comment must NOT be flagged.
  ok(!RAW.test(stripComments(`// never call identifyProduct directly\nconst x = 1;`)), 'comment mention not flagged');

  console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
