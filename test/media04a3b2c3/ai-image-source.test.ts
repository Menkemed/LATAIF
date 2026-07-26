// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C3 — safe AI-identifier image-input contract
// Run: node test/media04a3b2c3/ai-image-source.test.ts
//
// Pure selection / validation / freeze / stale-guard for the AI image input.
// No React, no productive DB, no base64 logged.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import {
  selectEphemeralNew, selectDurablePrimary, sameAiSource, shouldApplyAiResult,
  isRasterMime, isObjectUrl, parseDataUrlMime, type AiImageSource, type PrimaryResolution,
} from '../../src/core/media/ai-image-source.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  x ${m}`); } }
const hashOf = async (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const DATA = 'data:image/jpeg;base64,AAAA';

async function main(): Promise<void> {
  // ── helpers ────────────────────────────────────────────────────────────
  ok(isRasterMime('image/jpeg') && isRasterMime('image/png') && isRasterMime('image/webp') && !isRasterMime('image/gif') && !isRasterMime('application/pdf'), 'raster MIME allowlist');
  ok(isObjectUrl('blob:abc') && !isObjectUrl(DATA), 'isObjectUrl');
  ok(parseDataUrlMime(DATA) === 'image/jpeg' && parseDataUrlMime('nope') === null, 'parseDataUrlMime');

  // ── ephemeral_new ──────────────────────────────────────────────────────
  {
    const r = await selectEphemeralNew(DATA, 'c0', hashOf);
    ok(r.ok && r.source.kind === 'ephemeral_new' && r.source.mime === 'image/jpeg' && r.source.hash.length === 64, 'new data: image → ephemeral_new, frozen hash');
    const blob = await selectEphemeralNew('blob:live', 'c0', hashOf);
    ok(!blob.ok && blob.error === 'MEDIA_AI_OBJECT_URL_REJECTED', 'object/blob URL → rejected (never an identity)');
    const path = await selectEphemeralNew('C:/x/y.jpg', 'c0', hashOf);
    ok(!path.ok && path.error === 'MEDIA_AI_NOT_A_DATA_URL', 'bare path → rejected (no free file path)');
    const gif = await selectEphemeralNew('data:image/gif;base64,AA', 'c0', hashOf);
    ok(!gif.ok && gif.error === 'MEDIA_AI_UNSUPPORTED_MIME', 'non-raster MIME → rejected');
    const none = await selectEphemeralNew(undefined, 'c0', hashOf);
    ok(!none.ok && none.error === 'MEDIA_AI_NO_IMAGE', 'no image → typed error');
    // Freeze: a later different draft image is a DIFFERENT frozen source.
    const a = await selectEphemeralNew('data:image/png;base64,AAAA', 'c0', hashOf);
    const b = await selectEphemeralNew('data:image/png;base64,BBBB', 'c0', hashOf);
    ok(a.ok && b.ok && !sameAiSource(a.source, b.source), 'changed draft image → different frozen identity (old result not reused)');
  }

  // ── durable_primary ────────────────────────────────────────────────────
  const scope = { tenantId: 't1', branchId: 'b1', productId: 'p1' };
  {
    const media: PrimaryResolution = { kind: 'media', items: [{ mediaId: 'm0', mimeType: 'image/jpeg', sortOrder: 0, isPrimary: true }] };
    const r = selectDurablePrimary(scope, media);
    ok(r.ok && r.source.kind === 'durable_primary' && r.source.mediaId === 'm0', 'existing product → active primary from media SSOT');
    // A gallery whose primary is NOT slot 0, or a secondary, is never chosen.
    const secondaryOnly: PrimaryResolution = { kind: 'media', items: [{ mediaId: 'm1', mimeType: 'image/jpeg', sortOrder: 1, isPrimary: false }] };
    ok(!selectDurablePrimary(scope, secondaryOnly).ok, 'secondary-only gallery → no primary chosen');
    // Fail closed on every non-final / broken kind.
    for (const [kind, err] of [['pending', 'MEDIA_AI_GALLERY_NOT_READY'], ['conflict', 'MEDIA_AI_GALLERY_CONFLICT'], ['integrity_error', 'MEDIA_AI_INTEGRITY_ERROR'], ['legacy', 'MEDIA_AI_NOT_MIGRATED'], ['none', 'MEDIA_AI_NO_PRIMARY']] as const) {
      const res = selectDurablePrimary(scope, { kind } as PrimaryResolution);
      ok(!res.ok && res.error === err, `resolver '${kind}' → fail closed (${err})`);
    }
    // Non-raster primary MIME → refuse (never feed a non-image).
    const bad: PrimaryResolution = { kind: 'media', items: [{ mediaId: 'm0', mimeType: 'image/gif', sortOrder: 0, isPrimary: true }] };
    ok(!selectDurablePrimary(scope, bad).ok, 'non-raster primary → refused');
  }

  // ── stale guard ────────────────────────────────────────────────────────
  {
    const frozen: AiImageSource = { kind: 'durable_primary', tenantId: 't1', branchId: 'b1', productId: 'p1', mediaId: 'm0', mime: 'image/jpeg' };
    const same: AiImageSource = { ...frozen };
    const changedMedia: AiImageSource = { ...frozen, mediaId: 'm9' };
    ok(shouldApplyAiResult({ aborted: false, frozen, currentTargetProductId: 'p1', requestProductId: 'p1', currentSource: same }), 'unchanged → result applied');
    ok(!shouldApplyAiResult({ aborted: true, frozen, currentTargetProductId: 'p1', requestProductId: 'p1', currentSource: same }), 'aborted → not applied');
    ok(!shouldApplyAiResult({ aborted: false, frozen, currentTargetProductId: 'p2', requestProductId: 'p1', currentSource: same }), 'product switched → not applied (no stale update)');
    ok(!shouldApplyAiResult({ aborted: false, frozen, currentTargetProductId: 'p1', requestProductId: 'p1', currentSource: changedMedia }), 'primary changed under request → not applied');
    ok(!shouldApplyAiResult({ aborted: false, frozen, currentTargetProductId: 'p1', requestProductId: 'p1', currentSource: null }), 'gallery gone → not applied');
    // Retry: the SAME frozen source is stable → a retry reuses the identical hash/identity.
    const eph: AiImageSource = { kind: 'ephemeral_new', clientId: 'c0', mime: 'image/png', hash: 'h' };
    ok(sameAiSource(eph, { ...eph }) && !sameAiSource(eph, { ...eph, hash: 'h2' }), 'retry reuses identical frozen hash; a different hash is a different request');
  }

  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2C3 ai-image-source: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2C3 ai-image-source: ${PASS}/${PASS} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
