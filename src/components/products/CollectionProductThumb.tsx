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
// products that actually need a resolve. COLLECTIONS-S1/S2: that hook keeps only
// the card image in a bounded RAM cache (`core/media/card-image-cache`, revoked on
// eviction/logout/scope change, never under a card showing it) and resolves only
// once the card is near the viewport.
// ════════════════════════════════════════════════════════════════════════════

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Package } from 'lucide-react';
import { useCollectionCardImage } from '@/hooks/useCollectionCardImage';
import { useNearViewport } from '@/hooks/useNearViewport';
import { decideCollectionThumb, planPendingRetry } from '@/core/media/collection-thumb';

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
    return <img src={legacyFirst} alt="" loading="lazy" decoding="async" style={props.imgStyle ?? DEFAULT_IMG} />;
  }
  return <ResolvedThumb {...props} />;
}

// Mounted ONLY when the legacy column is empty → the resolver is the authority.
function ResolvedThumb(props: ThumbProps) {
  const { product, tenantId, branchId, imgStyle, iconSize = 36, iconColor = '#6B7280', iconStrokeWidth = 1 } = props;
  const hasAuthKey = !!product.id && !!tenantId && !!branchId;

  // DASH-I1 — bounded pending-retry. A resolve that lands on `pending` (the
  // create-batch is still finalizing — common on a cold Dashboard that mounts
  // ahead of the just-created product) would otherwise never re-run, since the
  // resolve key is stable. We bump `reloadNonce` after a capped backoff to force
  // a fresh resolve, up to `THUMB_PENDING_MAX_ATTEMPTS`, then fall back to the
  // placeholder. Component-local (one chain per mount) + the controller's own
  // single-flight guarantee ⇒ many cards never storm the resolver. No permanent
  // poller; the timer is cleared on unmount / key change / any non-pending state.
  const [nonce, setNonce] = useState(0);
  const [pendingExhausted, setPendingExhausted] = useState(false);
  const attemptsRef = useRef(0);
  // COLLECTIONS-S2 — the card resolves only once it is visible or about to be
  // (shared IntersectionObserver); until then it shows the neutral skeleton.
  const [el, setEl] = useState<Element | null>(null);
  const near = useNearViewport(el);
  // COLLECTIONS-S1 — a card image already loaded this session comes from the RAM
  // cache at once; the hook then only re-checks the gallery fingerprint.
  // `enabled = hasAuthKey`: with no authorised tenant/branch the hook stays idle,
  // so we fall through to the placeholder — never a cross-scope read.
  const state = useCollectionCardImage(product.id, tenantId, branchId, hasAuthKey, near, nonce);

  // A new resolve key is a brand-new retry budget (the previous chain's timer is
  // torn down by the effect below, whose deps also change).
  useEffect(() => {
    attemptsRef.current = 0;
    setPendingExhausted(false);
  }, [product.id, tenantId, branchId, hasAuthKey]);

  // `state` is a fresh object on every controller emit, so this re-runs on each
  // resolve conclusion — including two consecutive `pending`s — with exactly one
  // live timer (prior timer cleared in cleanup). `media`/`none`/`error` clear it
  // and never schedule, so those states never spin a retry loop.
  useEffect(() => {
    if (!hasAuthKey || state.status !== 'pending') return;
    const plan = planPendingRetry(attemptsRef.current);
    if (!plan.retry) { setPendingExhausted(true); return; }
    const timer = window.setTimeout(() => {
      attemptsRef.current += 1;
      setNonce((n) => n + 1);
    }, plan.delayMs);
    return () => window.clearTimeout(timer);
  }, [state, hasAuthKey]);

  const decision = decideCollectionThumb({ legacyFirst: undefined, state, hasAuthKey, pendingExhausted });

  if (decision.kind === 'image') {
    return <img ref={setEl} src={decision.src} alt="" decoding="async" style={imgStyle ?? DEFAULT_IMG} />;
  }
  if (decision.kind === 'skeleton') {
    // A resolve is genuinely in flight — show a neutral skeleton, never the
    // empty placeholder yet (mirrors ProductDetail's mediaResolving skeleton).
    return (
      <div
        ref={setEl}
        aria-hidden
        style={{ width: iconSize, height: iconSize, borderRadius: 6, background: 'rgba(107,114,128,0.15)' }}
      />
    );
  }
  return <Package size={iconSize} strokeWidth={iconStrokeWidth} style={{ color: iconColor }} />;
}
