// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C3-R1 — AI ephemeral input validation + stale/supersession guard
// Run: node test/media04a3b2c3r1/ai-input-validation.test.ts
//
// Pure validation (magic bytes ↔ MIME, byte + pixel bounds, no SVG) and the
// create-site stale/supersession decision. No React, no productive DB, no
// base64/content logged.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import {
  validateEphemeralImage, validateDurableBytes, sniffImageMime, readImageDimensions,
  shouldApplyEphemeralResult, MAX_AI_IMAGE_DIMENSION,
} from '../../src/core/media/ai-image-source.ts';

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
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // sig
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // len + IHDR
  b[16] = (w >>> 24) & 0xff; b[17] = (w >>> 16) & 0xff; b[18] = (w >>> 8) & 0xff; b[19] = w & 0xff;
  b[20] = (h >>> 24) & 0xff; b[21] = (h >>> 16) & 0xff; b[22] = (h >>> 8) & 0xff; b[23] = h & 0xff;
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0x00, 0x00, 0x00]);
}
function gif(): Uint8Array { return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]); }
function webp(): Uint8Array { const b = new Uint8Array(16); b.set([0x52, 0x49, 0x46, 0x46], 0); b.set([0x57, 0x45, 0x42, 0x50], 8); return b; }

async function main(): Promise<void> {
  // ── sniff + dimensions ─────────────────────────────────────────────────
  ok(sniffImageMime(jpeg(10, 10)) === 'image/jpeg' && sniffImageMime(png(10, 10)) === 'image/png' && sniffImageMime(webp()) === 'image/webp', 'sniff jpeg/png/webp');
  ok(sniffImageMime(gif()) === null && sniffImageMime(new TextEncoder().encode('<svg xmlns>')) === null, 'sniff GIF/SVG → null (not raster)');
  ok(JSON.stringify(readImageDimensions(png(123, 456), 'image/png')) === JSON.stringify({ width: 123, height: 456 }), 'png dimensions');
  ok(JSON.stringify(readImageDimensions(jpeg(321, 654), 'image/jpeg')) === JSON.stringify({ width: 321, height: 654 }), 'jpeg dimensions');

  // ── validateEphemeralImage ─────────────────────────────────────────────
  {
    const good = await validateEphemeralImage(dataUrl('image/png', png(100, 100)), 'c0', deps);
    ok(good.ok && good.source.kind === 'ephemeral_new' && good.source.mime === 'image/png' && good.source.hash.length === 64, 'valid PNG → ephemeral_new, frozen byte-hash');
    const goodJ = await validateEphemeralImage(dataUrl('image/jpeg', jpeg(50, 50)), 'c0', deps);
    ok(goodJ.ok, 'valid JPEG → ok');
    // hash is over DECODED bytes: same bytes with different base64 whitespace → same hash.
    const withWs = 'data:image/png;base64,' + Buffer.from(png(100, 100)).toString('base64').replace(/(.{4})/g, '$1\n');
    const g2 = await validateEphemeralImage(withWs, 'c0', deps);
    ok(g2.ok && good.ok && g2.source.hash === good.source.hash, 'hash from decoded bytes (whitespace-insensitive)');

    const bad64 = await validateEphemeralImage('data:image/png;base64,@@@not-base64@@@', 'c0', deps);
    ok(!bad64.ok && bad64.error === 'MEDIA_AI_MALFORMED_BASE64', 'malformed base64 → typed error, no provider call');
    const mismatch = await validateEphemeralImage(dataUrl('image/png', jpeg(10, 10)), 'c0', deps);
    ok(!mismatch.ok && mismatch.error === 'MEDIA_AI_MIME_MISMATCH', 'declared PNG but JPEG magic → MIME mismatch');
    const gifDecl = await validateEphemeralImage(dataUrl('image/png', gif()), 'c0', deps);
    ok(!gifDecl.ok && gifDecl.error === 'MEDIA_AI_UNSUPPORTED_MIME', 'GIF magic → unsupported (not raster allowlist)');
    const svg = await validateEphemeralImage('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'), 'c0', deps);
    ok(!svg.ok && svg.error === 'MEDIA_AI_UNSUPPORTED_MIME', 'SVG declared → rejected (no active content)');
    const tooBig = await validateEphemeralImage(dataUrl('image/png', png(100, 100)), 'c0', { ...deps, maxBytes: 10 });
    ok(!tooBig.ok && tooBig.error === 'MEDIA_AI_TOO_LARGE', 'over byte limit → too large');
    const tooWide = await validateEphemeralImage(dataUrl('image/jpeg', jpeg(9000, 100)), 'c0', deps);
    ok(!tooWide.ok && tooWide.error === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', `over ${MAX_AI_IMAGE_DIMENSION}px → too large dimensions`);
    const notB64 = await validateEphemeralImage('data:image/png,rawtext', 'c0', deps);
    ok(!notB64.ok && notB64.error === 'MEDIA_AI_NOT_BASE64', 'non-base64 data URL → rejected');
    const blob = await validateEphemeralImage('blob:live', 'c0', deps);
    ok(!blob.ok && blob.error === 'MEDIA_AI_OBJECT_URL_REJECTED', 'object/blob URL → rejected');
  }

  // ── validateDurableBytes ───────────────────────────────────────────────
  {
    ok(validateDurableBytes(jpeg(100, 100), 'image/jpeg').ok, 'durable JPEG bytes ↔ image/jpeg → ok');
    const mm = validateDurableBytes(jpeg(100, 100), 'image/png');
    ok(!mm.ok && mm.error === 'MEDIA_AI_MIME_MISMATCH', 'durable bytes MIME mismatch → error');
    ok(!validateDurableBytes(new Uint8Array(0), 'image/jpeg').ok, 'empty durable bytes → error');
    const big = validateDurableBytes(jpeg(9000, 9000), 'image/jpeg');
    ok(!big.ok && big.error === 'MEDIA_AI_TOO_LARGE_DIMENSIONS', 'oversized durable dimensions → error');
  }

  // ── stale / supersession ───────────────────────────────────────────────
  {
    const base = { unmounted: false, frozenImage: 'img-a', currentImage: 'img-a' };
    ok(shouldApplyEphemeralResult({ myRequestId: 1, latestRequestId: 1, ...base }), 'latest + mounted + unchanged image → apply');
    ok(!shouldApplyEphemeralResult({ myRequestId: 1, latestRequestId: 2, ...base }), 'superseded by newer request → not applied (second wins)');
    ok(!shouldApplyEphemeralResult({ myRequestId: 1, latestRequestId: 1, ...base, unmounted: true }), 'unmounted → not applied');
    ok(!shouldApplyEphemeralResult({ myRequestId: 1, latestRequestId: 1, ...base, currentImage: 'img-b' }), 'draft image changed → old result not applied');
  }

  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2C3-R1 ai-input-validation: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2C3-R1 ai-input-validation: ${PASS}/${PASS} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
