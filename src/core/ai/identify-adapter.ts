// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C3-R3 — central AI-identifier adapter, PRODUCTION binding.
//
// This is the ONLY file in the productive source tree allowed to import or call
// the raw `identifyProduct` provider. Every component/store must call
// `identifyProductFromResolvedInput` instead — never the provider directly. It:
//   • resolves + validates + freezes the safe AI image input (ephemeral_new for
//     a fresh pick, durable_primary for an existing product) via the resolver,
//   • calls the provider only on a non-blocking input,
//   • normalizes provider errors, and never logs image data.
// The repository-wide bypass gate (test/media04a3b2c3r3) enforces the single
// import site. Call-site stale/supersession/target guards stay at each site.
//
// POST-PARITY R7B PP-3 — on a computer without its own database (PC2) the provider is NOT this
// machine: the main computer identifies with ITS key (`primary-ai.ts` → `/api/ai/identify`). The
// image is resolved the same safe way — a freshly picked data: URL is validated exactly as on the
// Primary; an existing product's primary image comes as verified BYTES over the authenticated media
// route, never from a blob:/object display URL.
// ════════════════════════════════════════════════════════════════════════════

import { identifyProduct, type AiCategoryId, type AiProductIdentification } from './ai-service';
import { resolveAiImageInput } from '@/stores/productStore';
import { runIdentifyFromResolvedInput, type IdentifyHints, type IdentifyResult, type ResolvedAiInput } from './identify-adapter-core';
import { isClientMode } from '@/core/bridge/client-mode';
import { identifyViaPrimary } from './primary-ai';
import { loadRemoteGallery } from '@/core/media/client-media-source';
import { validateDurableBytes } from '@/core/media/ai-image-source';
import { sessionTenantId } from '@/core/data/shared-read';
import { currentBranchId } from '@/core/db/helpers';

export type IdentifyAdapterResult = IdentifyResult<AiProductIdentification>;

export const AI_PC2_NEEDS_PHOTO = 'On this computer AI Identify works from a photo — add one first.';

/** PC2: the image the main computer should identify — a fresh pick or the product's stored primary. */
async function resolveOnClient(productId: string | undefined, formImage0: string | undefined): Promise<ResolvedAiInput> {
  // A fresh pick: the same validation as on the Primary (pure bytes, no database involved).
  if (formImage0 && formImage0.startsWith('data:')) return resolveAiImageInput(undefined, formImage0);
  if (!productId) return { ok: false, error: 'MEDIA_AI_NO_IMAGE', blocking: false };
  let items: Awaited<ReturnType<typeof loadRemoteGallery>>;
  try {
    items = await loadRemoteGallery(productId);
  } catch (e) {
    return { ok: false, error: `MEDIA_AI_REMOTE_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`, blocking: true };
  }
  const prim = items.find((i) => i.isPrimary) ?? items[0];
  if (!prim) return { ok: false, error: 'MEDIA_AI_NO_PRIMARY', blocking: false };
  const bytes = new Uint8Array(await prim.blob.arrayBuffer());
  const dv = validateDurableBytes(bytes, prim.mimeType);
  if (!dv.ok) return { ok: false, error: dv.error, blocking: true };
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  let tenantId = '';
  let branchId = '';
  try { branchId = currentBranchId(); } catch { /* label only */ }
  try { tenantId = sessionTenantId(branchId) ?? ''; } catch { /* label only */ }
  return {
    ok: true,
    dataUrl: `data:${prim.mimeType};base64,${btoa(bin)}`,
    source: { kind: 'durable_primary', tenantId, branchId, productId, mediaId: prim.mediaId, mime: prim.mimeType },
  };
}

export async function identifyProductFromResolvedInput(params: {
  /** Existing product id → durable_primary; undefined → create (ephemeral_new). */
  productId: string | undefined;
  /** The picked/incoming primary image (data: URL for a fresh pick). */
  formImage0: string | undefined;
  categoryId: AiCategoryId;
  hints?: IdentifyHints;
  recentCorrections?: string;
}): Promise<IdentifyAdapterResult> {
  if (isClientMode()) {
    const resolved = await resolveOnClient(params.productId, params.formImage0);
    return runIdentifyFromResolvedInput(
      { categoryId: params.categoryId, hints: params.hints },
      resolved,
      (p) => {
        if (!p.imageBase64) throw new Error(AI_PC2_NEEDS_PHOTO);
        return identifyViaPrimary({ categoryId: p.categoryId, imageDataUrl: p.imageBase64, hints: { ...p.hints } });
      },
    );
  }
  const resolved = await resolveAiImageInput(params.productId, params.formImage0);
  return runIdentifyFromResolvedInput(
    { categoryId: params.categoryId, hints: params.hints, recentCorrections: params.recentCorrections },
    resolved,
    (p) => identifyProduct({ ...p, categoryId: p.categoryId as AiCategoryId }),
  );
}
