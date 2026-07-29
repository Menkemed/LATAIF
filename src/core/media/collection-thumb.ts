// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A10 — collection thumbnail decision (framework-agnostic).
//
// The collection grid/list historically rendered `products.images[0]` directly.
// Media-pipeline products (mobile upload + the media create flow) keep that
// column empty ('[]') and hold their photo in the content-addressed gallery, so
// those cards showed only a placeholder while ProductDetail — which reads the
// resolver — showed the real image. This closes that gap by deciding the card
// image from the SAME resolver, with the legacy column as a defined fallback.
//
// Pure and READ-ONLY: no DB, no Object-URL, no React. The URL lifecycle stays
// entirely inside the presentation controller / hook; this function only maps a
// resolved state (+ the legacy value) to what the card should paint.
// ════════════════════════════════════════════════════════════════════════════

import {
  presentationSrcs,
  isResolvingMedia,
  type PresentationState,
} from './presentation.ts';

export type ThumbDecision =
  | { kind: 'image'; src: string }
  | { kind: 'skeleton' }
  | { kind: 'placeholder' };

/**
 * Decide the thumbnail for ONE collection product.
 *
 * `legacyFirst` is `products.images[0]` (undefined when the column is empty). A
 * non-empty legacy column is the resolver's OWN step-1 decision
 * (product-media-resolver §"Decision order" 1): the resolver returns `legacy`
 * with exactly these items even when media links already exist, until the
 * cutover durably clears the column. A legacy image is therefore authoritative
 * and shown WITHOUT any resolve — which also keeps the legacy catalog at zero
 * added cost (no per-card gateway read).
 *
 * When the legacy column is empty (a media-pipeline product) the resolved
 * presentation state decides:
 *   • a concluded media/legacy resolution → its primary (`srcs[0]`)
 *   • a resolve still in flight for an authorised key → `skeleton` (never the
 *     empty placeholder yet, and never a transient legacy flash)
 *   • a concluded none/empty/error, or no authorised scope → `placeholder`
 * This mirrors ProductDetail's fail-closed hero: a deliberately emptied or
 * unverifiable gallery shows no image and never resurrects a legacy value.
 */
export function decideCollectionThumb(input: {
  legacyFirst: string | undefined;
  state: PresentationState;
  hasAuthKey: boolean;
}): ThumbDecision {
  if (input.legacyFirst) return { kind: 'image', src: input.legacyFirst };
  const primary = presentationSrcs(input.state)[0];
  if (primary) return { kind: 'image', src: primary };
  if (isResolvingMedia(input.state, input.hasAuthKey)) return { kind: 'skeleton' };
  return { kind: 'placeholder' };
}
