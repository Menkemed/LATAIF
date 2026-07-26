// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C3-R2 — pixel/decompression budget, identifier-bypass gate,
// sync auto-identify target guard.
// Run: node test/media04a3b2c3r2/pixel-budget-and-bypass.test.ts
//
// Pure logic + a static source-scan gate. No React, no productive DB, no
// base64/content logged.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateEphemeralImage, validateDurableBytes, checkPixelBudget,
  MAX_AI_IMAGE_PIXELS, MAX_AI_IMAGE_DIMENSION,
  frozenSyncTarget, shouldApplySyncAutoIdentify,
} from '../../src/core/media/ai-image-source.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  x ${m}`); } }

const hashBytes = async (b: Uint8Array) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const decodeBase64 = (b64: string): Uint8Array => {
  const clean = b64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('bad base64');
  return new Uint8Array(Buffer.from(clean, 'base64'));
};
const deps = { decodeBase64, hashBytes };
function dataUrl(mime: string, bytes: Uint8Array): string { return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`; }
// tiny byte payload but header claims arbitrary WxH (models a decompression bomb).
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  b[16] = (w >>> 24) & 0xff; b[17] = (w >>> 16) & 0xff; b[18] = (w >>> 8) & 0xff; b[19] = w & 0xff;
  b[20] = (h >>> 24) & 0xff; b[21] = (h >>> 16) & 0xff; b[22] = (h >>> 8) & 0xff; b[23] = h & 0xff;
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0x00, 0x00, 0x00]);
}

async function main(): Promise<void> {
  // ── 1. checkPixelBudget (pure, overflow-safe) ──────────────────────────────
  ok(checkPixelBudget(1000, 1000) === null, 'in-budget area → ok');
  ok(checkPixelBudget(4032, 3024) === null, 'real 12 MP phone photo → ok');
  ok(checkPixelBudget(0, 100) === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', 'width 0 → reject');
  ok(checkPixelBudget(100, 0) === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', 'height 0 → reject');
  ok(checkPixelBudget(-5, 100) === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', 'negative → reject');
  ok(checkPixelBudget(8193, 100) === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', 'over axis → reject');
  ok(checkPixelBudget(8192, 8192) === 'MEDIA_AI_TOO_MANY_PIXELS', '8192×8192 (67 MP) within axis but over pixel budget → reject');
  ok(checkPixelBudget(6000, 6000) === 'MEDIA_AI_TOO_MANY_PIXELS', '36 MP over budget → reject');
  ok(checkPixelBudget(0xffffffff, 0xffffffff) === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', 'u32-max header → axis rejects before any multiply (overflow-safe)');
  ok(checkPixelBudget(NaN, 100) === 'MEDIA_AI_DIMENSIONS_UNKNOWN', 'NaN → unknown');
  ok(checkPixelBudget(1.5, 100) === 'MEDIA_AI_DIMENSIONS_UNKNOWN', 'non-integer → unknown');
  // budget boundary is strictly-greater: exactly the budget passes.
  ok(checkPixelBudget(4096, MAX_AI_IMAGE_PIXELS / 4096) === null, 'exactly at pixel budget → ok');

  // ── validateEphemeralImage honours the pixel budget (no provider call) ──────
  {
    const bomb = await validateEphemeralImage(dataUrl('image/png', png(8192, 8192)), 'c0', deps);
    ok(!bomb.ok && bomb.error === 'MEDIA_AI_TOO_MANY_PIXELS', 'tiny bytes + 8192² header → reject (decompression guard)');
    const huge = await validateEphemeralImage(dataUrl('image/png', png(70000, 70000)), 'c0', deps);
    ok(!huge.ok && huge.error === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', 'extreme header dims → reject');
    const trunc = await validateEphemeralImage(dataUrl('image/png', png(100, 100).slice(0, 20)), 'c0', deps);
    ok(!trunc.ok && trunc.error === 'MEDIA_AI_DIMENSIONS_UNKNOWN', 'truncated header → fail closed (dimensions unknown)');
    const good = await validateEphemeralImage(dataUrl('image/jpeg', jpeg(1200, 900)), 'c0', deps);
    ok(good.ok, 'valid JPEG within budget → accepted');
    const goodP = await validateEphemeralImage(dataUrl('image/png', png(200, 200)), 'c0', deps);
    ok(goodP.ok, 'valid PNG within budget → accepted');
  }
  // durable bytes path enforces the same budget.
  ok(validateDurableBytes(png(8192, 8192), 'image/png').ok === false, 'durable 8192² → reject (budget)');
  ok(validateDurableBytes(png(300, 300), 'image/png').ok === true, 'durable in-budget → ok');

  // ── 2. identifier-bypass gate (static source scan) ─────────────────────────
  // Every productive identifyProduct call site must source imageBase64 from the
  // central resolveAiImageInput result — never a raw form/product/blob image.
  const CALL_SITES = [
    'src/pages/watches/ProductDetail.tsx',
    'src/pages/watches/WatchList.tsx',
    'src/pages/consignments/ConsignmentList.tsx',
    'src/components/products/NewProductModal.tsx',
    'src/components/sync/SyncDuplicateGuard.tsx',
  ];
  // Post-R3: imageBase64 is set ONLY inside the central adapter core — no call
  // site carries a raw imageBase64 arg anymore. Each site routes via the adapter.
  function countImageBase64(content: string): number {
    let total = 0;
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('//') || line.startsWith('*')) continue;
      if (line.includes('imageBase64:')) total++;
    }
    return total;
  }
  for (const rel of CALL_SITES) {
    const content = readFileSync(join(ROOT, rel), 'utf8');
    ok(countImageBase64(content) === 0, `${rel}: no raw imageBase64 arg (centralized in adapter)`);
    ok(content.includes('identifyProductFromResolvedInput'), `${rel}: routes via the central adapter`);
  }
  // the adapter core is the single place that assembles imageBase64.
  const coreSrc = readFileSync(join(ROOT, 'src/core/ai/identify-adapter-core.ts'), 'utf8');
  ok(countImageBase64(coreSrc) >= 1, 'adapter core is the single imageBase64 assembly site');

  // ── 3. sync auto-identify target guard ─────────────────────────────────────
  const rec = { id: 'p1', images: ['data:image/png;base64,AAA'] };
  const frozen = frozenSyncTarget({ id: rec.id, imageRef: rec.images[0] });
  // retry with identical input → same frozen key (idempotent replay)
  const frozen2 = frozenSyncTarget({ id: rec.id, imageRef: rec.images[0] });
  ok(frozen.productKey === frozen2.productKey && frozen.imageKey === frozen2.imageKey, 'retry unchanged input → same frozen key');

  // happy path: same epoch, target exists, image unchanged → apply
  ok(shouldApplySyncAutoIdentify({ myEpoch: 1, latestEpoch: 1, targetExists: true, frozenImageKey: frozen.imageKey, currentImageKey: rec.images[0] }) === true, 'unchanged target + latest epoch → apply');
  // superseded: a newer run bumped the epoch → skip
  ok(shouldApplySyncAutoIdentify({ myEpoch: 1, latestEpoch: 2, targetExists: true, frozenImageKey: frozen.imageKey, currentImageKey: rec.images[0] }) === false, 'newer run supersedes older → skip');
  // target removed
  ok(shouldApplySyncAutoIdentify({ myEpoch: 1, latestEpoch: 1, targetExists: false, frozenImageKey: frozen.imageKey, currentImageKey: undefined }) === false, 'target vanished → skip');
  // target image changed
  ok(shouldApplySyncAutoIdentify({ myEpoch: 1, latestEpoch: 1, targetExists: true, frozenImageKey: frozen.imageKey, currentImageKey: 'data:image/png;base64,BBB' }) === false, 'target image changed → skip');
  // target image removed under the request
  ok(shouldApplySyncAutoIdentify({ myEpoch: 1, latestEpoch: 1, targetExists: true, frozenImageKey: frozen.imageKey, currentImageKey: undefined }) === false, 'target image removed → skip');
  // frozen image missing at request start → skip (no identity to defend)
  ok(shouldApplySyncAutoIdentify({ myEpoch: 1, latestEpoch: 1, targetExists: true, frozenImageKey: null, currentImageKey: 'x' }) === false, 'no frozen image → skip');

  console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
