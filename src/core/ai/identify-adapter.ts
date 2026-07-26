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
// ════════════════════════════════════════════════════════════════════════════

import { identifyProduct, type AiCategoryId, type AiProductIdentification } from './ai-service';
import { resolveAiImageInput } from '@/stores/productStore';
import { runIdentifyFromResolvedInput, type IdentifyHints, type IdentifyResult } from './identify-adapter-core';

export type IdentifyAdapterResult = IdentifyResult<AiProductIdentification>;

export async function identifyProductFromResolvedInput(params: {
  /** Existing product id → durable_primary; undefined → create (ephemeral_new). */
  productId: string | undefined;
  /** The picked/incoming primary image (data: URL for a fresh pick). */
  formImage0: string | undefined;
  categoryId: AiCategoryId;
  hints?: IdentifyHints;
  recentCorrections?: string;
}): Promise<IdentifyAdapterResult> {
  const resolved = await resolveAiImageInput(params.productId, params.formImage0);
  return runIdentifyFromResolvedInput(
    { categoryId: params.categoryId, hints: params.hints, recentCorrections: params.recentCorrections },
    resolved,
    (p) => identifyProduct({ ...p, categoryId: p.categoryId as AiCategoryId }),
  );
}
