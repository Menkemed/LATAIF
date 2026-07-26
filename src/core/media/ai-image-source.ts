// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C3 — safe AI-identifier image-input contract.
//
// Every productive AI-identifier call must pick its image from ONE of exactly
// two safe sources, and freeze that choice for the whole request:
//
//   • ephemeral_new  — a freshly selected, NOT-yet-persisted image. Its own
//                      data: URL is the source (never an object/blob URL, never
//                      products.images). Frozen by content hash so a later draft
//                      change can't reinterpret the in-flight request. Its bytes
//                      are never written to SQLite or the media SSOT.
//   • durable_primary — an existing product's VERIFIED active primary medium,
//                      read scope-exact through the resolver (tenant/branch/
//                      product bound, active link, current generation, hash
//                      integrity, MASTER raster — never a thumbnail). Never a
//                      free file path, never products.images.
//
// Fail closed: a non-final gallery (pending/conflict/integrity_error), a missing
// primary, an object/blob URL, or an unsupported MIME all refuse the call with a
// typed error — the provider is never invoked on an unsafe input.
//
// This module is PURE + framework-agnostic + node-testable. Byte fetching and
// the provider call live in the store/UI layer; here we only SELECT + VALIDATE
// + FREEZE + compare identities. NEVER logs image bytes / base64.
// ════════════════════════════════════════════════════════════════════════════

/** The frozen identity of the image an AI request runs against. */
export type AiImageSource =
  | { kind: 'ephemeral_new'; clientId: string; mime: string; hash: string }
  | {
      kind: 'durable_primary';
      tenantId: string;
      branchId: string;
      productId: string;
      mediaId: string;
      mime: string;
    };

export type AiSourceSelection =
  | { ok: true; source: AiImageSource }
  | { ok: false; error: string };

const RASTER_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
export function isRasterMime(m: string | null | undefined): boolean {
  return !!m && RASTER_MIME.has(m.toLowerCase());
}
function normMime(m: string): string { return m.toLowerCase() === 'image/jpg' ? 'image/jpeg' : m.toLowerCase(); }

// ── canonical bounds (3B2C3-R1) ──────────────────────────────────────────────
// Byte ceiling mirrors the Rust ingest cap (media/ingest.rs MAX_INGEST_INPUT_BYTES
// = 25 MiB) — the same limit the durable pipeline already enforces. No canonical
// PIXEL limit existed in the codebase (ImageUpload compresses to ≤800px, but
// that is a target, not a validated bound), so this is the smallest centrally
// documented safe cap above that target — a hard per-side dimension limit that
// also defuses decompression bombs.
export const MAX_AI_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_AI_IMAGE_DIMENSION = 8192;
// Pixel (area) budget — a per-side limit alone is not a decompression guard:
// 8192×8192 = 67 MP would decode to ≈ 268 MB RGBA. We cap the DECODED footprint
// instead. 24 MP (≈ 96 MB RGBA at 4 B/px) is derived from a conservative decoder
// memory ceiling: it comfortably admits real device photos (a 12 MP phone shot,
// 4032×3024 ≈ 12.2 MP; a 24 MP DSLR frame) while rejecting header-declared bombs
// well below the axis limit. Enforced BEFORE any decode/provider call.
export const MAX_AI_IMAGE_PIXELS = 24 * 1024 * 1024;

/**
 * Overflow-safe area check. Returns a typed error string or null (ok). The axis
 * bounds are validated FIRST, so by the time we multiply, both sides are finite
 * integers ≤ MAX_AI_IMAGE_DIMENSION (8192) → the product ≤ 67,108,864, far under
 * Number.MAX_SAFE_INTEGER (2^53) — no silent overflow. A header that declares a
 * gigantic side (e.g. PNG width 0xFFFFFFFF) is caught by the axis bound before
 * any multiplication happens.
 */
export function checkPixelBudget(
  width: number,
  height: number,
  maxDim = MAX_AI_IMAGE_DIMENSION,
  maxPixels = MAX_AI_IMAGE_PIXELS,
): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'MEDIA_AI_DIMENSIONS_UNKNOWN';
  if (!Number.isInteger(width) || !Number.isInteger(height)) return 'MEDIA_AI_DIMENSIONS_UNKNOWN';
  if (width <= 0 || height <= 0) return 'MEDIA_AI_TOO_LARGE_DIMENSIONS';
  if (width > maxDim || height > maxDim) return 'MEDIA_AI_TOO_LARGE_DIMENSIONS';
  // both sides ≤ maxDim here → product is overflow-safe.
  if (width * height > maxPixels) return 'MEDIA_AI_TOO_MANY_PIXELS';
  return null;
}

/** Content-sniff the real raster type from magic bytes (independent of the
 *  declared MIME). Returns null for anything that is not a supported raster —
 *  including GIF and SVG/other active/text content. */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** Parse (width,height) from a raster's header bytes. Null when it cannot be
 *  determined — the caller fails closed (a pixel bound it cannot verify is a
 *  bound it must not trust). */
export function readImageDimensions(b: Uint8Array, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png') {
    if (b.length < 24) return null;
    const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    return { width: w, height: h };
  }
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      // SOF0..SOF15 carry the frame size; skip the non-SOF markers in that range.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return { width: w, height: h };
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (mime === 'image/webp') {
    if (b.length >= 30 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58) { // VP8X
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { width: w, height: h };
    }
    if (b.length >= 30 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x20) { // VP8 lossy
      const w = (b[26] | (b[27] << 8)) & 0x3fff;
      const h = (b[28] | (b[29] << 8)) & 0x3fff;
      return { width: w, height: h };
    }
    return null; // VP8L / unknown → fail closed
  }
  return null;
}

export interface EphemeralValidateDeps {
  /** Decode a base64 payload to bytes (atob-based in the app, Buffer in tests). */
  decodeBase64: (b64: string) => Uint8Array;
  /** Content hash of the DECODED bytes (the frozen identity). */
  hashBytes: (bytes: Uint8Array) => Promise<string>;
  maxBytes?: number;
  maxDimension?: number;
}

export type EphemeralValidation =
  | { ok: true; source: Extract<AiImageSource, { kind: 'ephemeral_new' }>; bytes: Uint8Array }
  | { ok: false; error: string };

/**
 * Fully validate a freshly-picked image BEFORE any provider call: valid data:
 * URL, a raster MIME (never SVG/active content), fully base64-decodable, the
 * declared MIME must match the decoded MAGIC bytes, hard byte + per-side pixel
 * limits, and the frozen hash is taken from the DECODED bytes. Fails closed with
 * a typed error — no provider call, no base64/content in the message.
 */
export async function validateEphemeralImage(candidate: string | undefined, clientId: string, deps: EphemeralValidateDeps): Promise<EphemeralValidation> {
  const maxBytes = deps.maxBytes ?? MAX_AI_INPUT_BYTES;
  const maxDim = deps.maxDimension ?? MAX_AI_IMAGE_DIMENSION;
  if (!candidate) return { ok: false, error: 'MEDIA_AI_NO_IMAGE' };
  if (isObjectUrl(candidate)) return { ok: false, error: 'MEDIA_AI_OBJECT_URL_REJECTED' };
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(candidate);
  if (!m) return { ok: false, error: 'MEDIA_AI_NOT_A_DATA_URL' };
  const declaredMime = m[1];
  if (!isRasterMime(declaredMime)) return { ok: false, error: 'MEDIA_AI_UNSUPPORTED_MIME' }; // also rejects image/svg+xml
  if (!m[2]) return { ok: false, error: 'MEDIA_AI_NOT_BASE64' };
  let bytes: Uint8Array;
  try {
    bytes = deps.decodeBase64(m[3]);
    if (!bytes || bytes.length === 0) return { ok: false, error: 'MEDIA_AI_MALFORMED_BASE64' };
  } catch {
    return { ok: false, error: 'MEDIA_AI_MALFORMED_BASE64' };
  }
  if (bytes.length > maxBytes) return { ok: false, error: 'MEDIA_AI_TOO_LARGE' };
  const sniff = sniffImageMime(bytes);
  if (!sniff) return { ok: false, error: 'MEDIA_AI_UNSUPPORTED_MIME' }; // GIF/SVG/other
  if (sniff !== normMime(declaredMime)) return { ok: false, error: 'MEDIA_AI_MIME_MISMATCH' };
  const dim = readImageDimensions(bytes, sniff);
  if (!dim) return { ok: false, error: 'MEDIA_AI_DIMENSIONS_UNKNOWN' };
  const budgetErr = checkPixelBudget(dim.width, dim.height, maxDim);
  if (budgetErr) return { ok: false, error: budgetErr };
  const hash = await deps.hashBytes(bytes);
  return { ok: true, source: { kind: 'ephemeral_new', clientId, mime: sniff, hash }, bytes };
}

/**
 * Validate the DURABLE primary bytes the resolver returned before building the
 * provider data: URL: the bytes must magic-match the expected raster MIME and be
 * within the same bounds. (Hash + scope + generation were already verified by
 * the resolver's `readVerifiedMedia`; this is the final content-shape check.)
 */
export function validateDurableBytes(bytes: Uint8Array, expectedMime: string, maxBytes = MAX_AI_INPUT_BYTES, maxDim = MAX_AI_IMAGE_DIMENSION): { ok: true } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: 'MEDIA_AI_EMPTY' };
  if (bytes.length > maxBytes) return { ok: false, error: 'MEDIA_AI_TOO_LARGE' };
  const sniff = sniffImageMime(bytes);
  if (!sniff) return { ok: false, error: 'MEDIA_AI_UNSUPPORTED_MIME' };
  if (sniff !== normMime(expectedMime)) return { ok: false, error: 'MEDIA_AI_MIME_MISMATCH' };
  const dim = readImageDimensions(bytes, sniff);
  if (!dim) return { ok: false, error: 'MEDIA_AI_DIMENSIONS_UNKNOWN' };
  const budgetErr = checkPixelBudget(dim.width, dim.height, maxDim);
  if (budgetErr) return { ok: false, error: budgetErr };
  return { ok: true };
}

/**
 * Whether a create-site (no productId yet) may apply an AI result: the request
 * must be the LATEST (a newer request supersedes), the component still mounted,
 * and the frozen picked image still the current draft image (a draft change
 * discards the old result).
 */
export function shouldApplyEphemeralResult(args: {
  myRequestId: number;
  latestRequestId: number;
  unmounted: boolean;
  frozenImage: string | undefined;
  currentImage: string | undefined;
}): boolean {
  if (args.unmounted) return false;
  if (args.myRequestId !== args.latestRequestId) return false;
  return args.frozenImage === args.currentImage;
}
export function isObjectUrl(s: string): boolean {
  return typeof s === 'string' && s.startsWith('blob:');
}
export function parseDataUrlMime(dataUrl: string): string | null {
  const m = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return m ? m[1] : null;
}

/**
 * Select an `ephemeral_new` source from a freshly picked image. The candidate
 * MUST be a raster `data:` URL — an object/blob URL, a bare path, or a non-raster
 * MIME is refused. `hashOf` freezes the content identity (async, injected).
 */
export async function selectEphemeralNew(
  candidate: string | undefined,
  clientId: string,
  hashOf: (s: string) => Promise<string>,
): Promise<AiSourceSelection> {
  if (!candidate) return { ok: false, error: 'MEDIA_AI_NO_IMAGE' };
  if (isObjectUrl(candidate)) return { ok: false, error: 'MEDIA_AI_OBJECT_URL_REJECTED' };
  if (!candidate.startsWith('data:')) return { ok: false, error: 'MEDIA_AI_NOT_A_DATA_URL' };
  const mime = parseDataUrlMime(candidate);
  if (!isRasterMime(mime)) return { ok: false, error: 'MEDIA_AI_UNSUPPORTED_MIME' };
  const hash = await hashOf(candidate);
  return { ok: true, source: { kind: 'ephemeral_new', clientId, mime: mime as string, hash } };
}

/** The primary-resolution shape this module consumes (subset of the resolver's
 *  ProductMediaResolution). */
export type PrimaryResolution =
  | { kind: 'media'; items: Array<{ mediaId: string; mimeType: string; sortOrder: number; isPrimary: boolean }> }
  | { kind: 'legacy' | 'none' | 'pending' | 'conflict' | 'integrity_error' | 'legacy_format_error' };

const NON_MEDIA_ERROR: Record<string, string> = {
  pending: 'MEDIA_AI_GALLERY_NOT_READY',
  conflict: 'MEDIA_AI_GALLERY_CONFLICT',
  integrity_error: 'MEDIA_AI_INTEGRITY_ERROR',
  legacy: 'MEDIA_AI_NOT_MIGRATED',
  legacy_format_error: 'MEDIA_AI_LEGACY_FORMAT',
  none: 'MEDIA_AI_NO_PRIMARY',
};

/**
 * Select a `durable_primary` source from a scope-exact primary resolution. Only
 * a fully-resolved `media` gallery is acceptable (fail closed otherwise), and
 * ONLY the item that is primary AND at slot 0 is used — a secondary image is
 * never silently chosen. The resolver already proved scope + active link +
 * current generation + hash integrity + the MASTER raster (never a thumbnail).
 */
export function selectDurablePrimary(
  scope: { tenantId: string; branchId: string; productId: string },
  res: PrimaryResolution,
): AiSourceSelection {
  if (res.kind !== 'media') {
    return { ok: false, error: NON_MEDIA_ERROR[res.kind] ?? 'MEDIA_AI_GALLERY_NOT_READY' };
  }
  const primary = res.items.find((i) => i.isPrimary && i.sortOrder === 0);
  if (!primary) return { ok: false, error: 'MEDIA_AI_NO_PRIMARY' };
  if (!isRasterMime(primary.mimeType)) return { ok: false, error: 'MEDIA_AI_UNSUPPORTED_MIME' };
  return { ok: true, source: { kind: 'durable_primary', tenantId: scope.tenantId, branchId: scope.branchId, productId: scope.productId, mediaId: primary.mediaId, mime: primary.mimeType } };
}

/** True iff two frozen sources are the SAME identity — the stale guard applied
 *  before an AI result is applied and before a retry reuses a request. */
export function sameAiSource(a: AiImageSource, b: AiImageSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ephemeral_new' && b.kind === 'ephemeral_new') return a.hash === b.hash;
  if (a.kind === 'durable_primary' && b.kind === 'durable_primary') {
    return a.tenantId === b.tenantId && a.branchId === b.branchId && a.productId === b.productId && a.mediaId === b.mediaId;
  }
  return false;
}

/**
 * Whether an AI result may be applied. Refused when the request was aborted, the
 * view moved to another product, or the image identity changed under the request
 * (draft edited / gallery mutated) — so a stale result never lands on the wrong
 * product or a different image.
 */
export function shouldApplyAiResult(args: {
  aborted: boolean;
  frozen: AiImageSource;
  currentTargetProductId: string | null;
  requestProductId: string | null;
  currentSource: AiImageSource | null;
}): boolean {
  if (args.aborted) return false;
  if (args.requestProductId !== args.currentTargetProductId) return false;
  if (!args.currentSource) return false;
  return sameAiSource(args.frozen, args.currentSource);
}

// ── Sync auto-identify target guard (3B2C3-R2) ───────────────────────────────
// The sync auto-identify path has no React refs, so its supersession/target
// guard is a pure decision consumed by a module-level epoch registry.

/** Freeze the target identity of a sync/candidate record at request start. The
 *  key is derived deterministically, so a retry with the SAME record + image
 *  yields the SAME frozen key (proving idempotent replay), while a changed or
 *  removed image key is detected on apply. */
export function frozenSyncTarget(rec: { id: string; imageRef: string | undefined | null }): {
  productKey: string;
  imageKey: string | null;
} {
  return { productKey: rec.id, imageKey: rec.imageRef ?? null };
}

/**
 * Whether a sync auto-identify result may be applied. Refused when the target
 * product vanished, a NEWER auto-identify run for the same product superseded
 * this one (epoch mismatch), the frozen image is missing, or the target's image
 * changed/was removed under the in-flight request — so a stale result never
 * lands on a mutated or newer target.
 */
export function shouldApplySyncAutoIdentify(args: {
  myEpoch: number;
  latestEpoch: number;
  targetExists: boolean;
  frozenImageKey: string | null;
  currentImageKey: string | null | undefined;
}): boolean {
  if (!args.targetExists) return false;
  if (args.myEpoch !== args.latestEpoch) return false;
  if (args.frozenImageKey == null) return false;
  return args.frozenImageKey === (args.currentImageKey ?? null);
}
