// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B1 — React adapter over ProductMediaPresentationController.
//
// A THIN wrapper. All lifecycle-critical logic (staleness, Object-URL
// revoke-exactly-once, no-legacy-on-error) lives in the framework-agnostic
// controller in `core/media/presentation.ts`, which the 3B1 suite drives under
// node. This hook only:
//   • builds one controller per mounted component
//   • (re)loads whenever the memoised key changes
//   • disposes on unmount (revoking every live Object-URL)
//
// It is READ-ONLY: it never writes the store, never mutates products.images,
// never persists an Object-URL. The productive DB is pinned through the
// existing lifecycle lease for the duration of each resolve.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import {
  ProductMediaPresentationController,
  IDLE_STATE,
  type PresentationState,
} from '@/core/media/presentation';

/**
 * Resolve and present the ordered media gallery for one product.
 *
 * @param productId  the product whose gallery to show
 * @param tenantId   the authorised tenant that owns the branch (DB-derived)
 * @param branchId   the authorised session branch
 * @param enabled    skip resolving entirely (e.g. while editing) — the hook
 *                   still owns teardown, so any prior URLs are revoked
 */
export function useProductMediaPresentation(
  productId: string | undefined,
  tenantId: string | undefined,
  branchId: string | undefined,
  enabled = true,
): PresentationState {
  const [state, setState] = useState<PresentationState>(IDLE_STATE);
  const controllerRef = useRef<ProductMediaPresentationController | null>(null);

  // One controller for the component's whole lifetime; disposed on unmount.
  useEffect(() => {
    let mounted = true;
    const controller = new ProductMediaPresentationController({
      // Lazy imports keep Tauri/DB out of the initial render bundle path and
      // out of any non-Tauri context (e.g. the web preview without a backend).
      gateway: {
        async readVerifiedMedia(input) {
          const { TauriMediaGateway } = await import('@/core/media/gateway');
          return new TauriMediaGateway().readVerifiedMedia(input);
        },
      },
      acquireLease: async () => {
        const { acquireDbLease } = await import('@/core/db/database');
        return acquireDbLease();
      },
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
      onChange: (s) => {
        if (mounted) setState(s);
      },
    });
    controllerRef.current = controller;
    return () => {
      mounted = false;
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // (Re)load only when the resolve key actually changes — never every render.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (!enabled || !productId || !tenantId || !branchId) {
      // Nothing authorised to show (e.g. entering edit mode, or no tenant yet).
      // `clear()` revokes any live Object-URLs, cancels an in-flight resolve
      // and emits idle — so no URL leaks while presentation is disabled.
      controller.clear();
      return;
    }
    void controller.load({ productId, tenantId, branchId });
  }, [productId, tenantId, branchId, enabled]);

  return state;
}
