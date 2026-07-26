// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C3-R3 — central AI-identifier adapter, PURE core.
//
// The single orchestration that every productive identify call must go through:
//   1. take an ALREADY-resolved+validated frozen AI input (ephemeral_new or
//      durable_primary), 2. call the provider only when the input is not a
//      blocking failure, 3. normalize provider errors, 4. NEVER log image data.
//
// This core is framework- and provider-agnostic (injected `callProvider`), so it
// is node-testable without loading the OpenAI service or the product store. The
// thin production binding lives in `identify-adapter.ts` — the ONLY file allowed
// to import the raw `identifyProduct` provider.
// ════════════════════════════════════════════════════════════════════════════

import type { AiImageSource } from '@/core/media/ai-image-source';

/** Shape returned by the resolver (productStore.resolveAiImageInput). */
export type ResolvedAiInput =
  | { ok: true; dataUrl: string; source: AiImageSource }
  | { ok: false; error: string; blocking: boolean };

export interface IdentifyHints {
  brand?: string;
  name?: string;
  reference?: string;
  serial?: string;
  notes?: string;
}

export interface IdentifyProviderParams {
  categoryId: string;
  imageBase64?: string;
  hints?: IdentifyHints;
  recentCorrections?: string;
}

export interface IdentifyCoreParams {
  categoryId: string;
  hints?: IdentifyHints;
  recentCorrections?: string;
}

export type IdentifyResult<R> =
  | { ok: true; result: R; source: AiImageSource | null; usedImage: boolean }
  | { ok: false; error: string; blocking: boolean };

/** Turn any thrown provider error into a short, safe message — never echoes
 *  image bytes/base64 (the provider params are not part of the message). */
export function normalizeProviderError(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const msg = String((e as { message?: unknown }).message ?? '').trim();
    if (msg) return msg.slice(0, 300);
  }
  if (typeof e === 'string' && e.trim()) return e.trim().slice(0, 300);
  return 'MEDIA_AI_PROVIDER_ERROR';
}

/**
 * Run the provider against a resolved input, with a frozen source identity that
 * the call site's stale/supersession/target guard can compare before applying.
 *   • blocking resolver failure  → never calls the provider (fail closed).
 *   • non-blocking failure (no usable image) → runs a TEXT-ONLY identification.
 *   • provider throw → normalized, blocking failure (no partial result applied).
 */
export async function runIdentifyFromResolvedInput<R>(
  params: IdentifyCoreParams,
  resolved: ResolvedAiInput,
  callProvider: (p: IdentifyProviderParams) => Promise<R>,
): Promise<IdentifyResult<R>> {
  if (!resolved.ok && resolved.blocking) {
    return { ok: false, error: resolved.error, blocking: true };
  }
  try {
    const result = await callProvider({
      categoryId: params.categoryId,
      imageBase64: resolved.ok ? resolved.dataUrl : undefined,
      hints: params.hints,
      recentCorrections: params.recentCorrections,
    });
    return { ok: true, result, source: resolved.ok ? resolved.source : null, usedImage: resolved.ok };
  } catch (e) {
    return { ok: false, error: normalizeProviderError(e), blocking: true };
  }
}
