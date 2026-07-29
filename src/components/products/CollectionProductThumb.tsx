// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A10 — collection card/list thumbnail.
//
// Renders a product's primary image for the Collection overview using the SAME
// read-only media resolver as ProductDetail (via `useProductMediaPresentation`),
// so media-pipeline products (mobile upload / media create) finally show their
// photo in the grid — not just on the detail page.
//
// Performance: a product whose legacy `images` column is non-empty is painted
// directly (that value is the resolver's own step-1 answer), so the hook is
// mounted ONLY for products with an empty legacy column — the media-pipeline
// products that actually need a resolve. The hook owns the Object-URL lifecycle
// and revokes on unmount (card removal / filter change), so nothing leaks.
// ════════════════════════════════════════════════════════════════════════════

import type { CSSProperties } from 'react';
import { Package } from 'lucide-react';
import { useProductMediaPresentation } from '@/hooks/useProductMediaPresentation';
import { decideCollectionThumb } from '@/core/media/collection-thumb';

interface ThumbProps {
  product: { id: string; images: string[] };
  tenantId: string | undefined;
  branchId: string | undefined;
  imgStyle?: CSSProperties;
  iconSize?: number;
  iconColor?: string;
  iconStrokeWidth?: number;
}

const DEFAULT_IMG: CSSProperties = { width: '100%', height: '100%', objectFit: 'contain' };

export function CollectionProductThumb(props: ThumbProps) {
  const { product } = props;
  const legacyFirst = product.images && product.images.length > 0 ? product.images[0] : undefined;
  // Fast path: a non-empty legacy column is authoritative (resolver step 1) and
  // shown directly — no resolve, no gateway read for the legacy catalog.
  if (legacyFirst) {
    return <img src={legacyFirst} alt="" style={props.imgStyle ?? DEFAULT_IMG} />;
  }
  return <ResolvedThumb {...props} />;
}

// Mounted ONLY when the legacy column is empty → the resolver is the authority.
function ResolvedThumb(props: ThumbProps) {
  const { product, tenantId, branchId, imgStyle, iconSize = 36, iconColor = '#6B7280', iconStrokeWidth = 1 } = props;
  const hasAuthKey = !!product.id && !!tenantId && !!branchId;
  // `enabled = hasAuthKey`: with no authorised tenant/branch the hook stays idle
  // (and still owns teardown), so we fall through to the placeholder — never a
  // cross-scope read.
  const state = useProductMediaPresentation(product.id, tenantId, branchId, hasAuthKey);
  const decision = decideCollectionThumb({ legacyFirst: undefined, state, hasAuthKey });

  if (decision.kind === 'image') {
    return <img src={decision.src} alt="" style={imgStyle ?? DEFAULT_IMG} />;
  }
  if (decision.kind === 'skeleton') {
    // A resolve is genuinely in flight — show a neutral skeleton, never the
    // empty placeholder yet (mirrors ProductDetail's mediaResolving skeleton).
    return (
      <div
        aria-hidden
        style={{ width: iconSize, height: iconSize, borderRadius: 6, background: 'rgba(107,114,128,0.15)' }}
      />
    );
  }
  return <Package size={iconSize} strokeWidth={iconStrokeWidth} style={{ color: iconColor }} />;
}
