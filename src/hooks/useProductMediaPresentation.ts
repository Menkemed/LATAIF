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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useProductStore } from '@/stores/productStore';
import {
  ProductMediaPresentationController,
  IDLE_STATE,
  type PresentationState,
} from '@/core/media/presentation';
import { readsFromPrimary } from '@/core/data/primary-source';
import { loadRemoteGallery } from '@/core/media/client-media-source';

const LOADING_STATE: PresentationState = { status: 'loading', srcs: [] };

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
  /** Bump to force an explicit re-resolve WITHOUT a key change — e.g. right
   *  after a durable edit save, so the new gallery replaces the old one and the
   *  previous Object-URLs are revoked exactly once (3B2C2-R2). */
  reloadNonce = 0,
): PresentationState {
  // CENTRAL-UI-PARITY R5B — ein Rechner ohne Datenbank hat weder die Verknüpfungen noch den
  // Medienspeicher. Er liest die Galerie beim Primary (`core/media/client-media-source`); der lokale
  // Resolver bleibt dort ausgeschaltet und greift nie nach einer Datenbank, die es nicht gibt.
  const remote = readsFromPrimary();
  const local = useLocalPresentation(productId, tenantId, branchId, enabled && !remote, reloadNonce);
  const fern = useRemotePresentation(productId, enabled && remote, reloadNonce);
  return remote ? fern : local;
}

/**
 * Die Galerie vom Primary: dieselbe Ordnung (Hauptbild zuerst), dieselben Zustände. Jede
 * Objekt-URL wird genau einmal wieder freigegeben — beim Wechsel des Artikels und beim Abbau.
 */
function useRemotePresentation(productId: string | undefined, enabled: boolean, reloadNonce: number): PresentationState {
  // Schritt 1 des Resolvers, derselbe Vertrag: eine NICHT LEERE Altspalte (`products.images`) ist
  // maßgeblich — auch mitten in einer Umstellung. Sie kommt auf dem zweiten Rechner mit dem
  // gemeinsamen Artikelbestand; ein Artikel mit alten Bildern zeigt sie also unverändert.
  const legacy = useProductStore((s) => (productId ? s.products.find((p) => p.id === productId)?.images : undefined));
  const legacyState = useMemo<PresentationState | null>(
    () => (legacy && legacy.length > 0 ? { status: 'legacy', srcs: legacy } : null),
    [legacy],
  );
  const key = enabled && productId && !legacyState ? `${productId}#${reloadNonce}` : '';
  const [held, setHeld] = useState<{ key: string; state: PresentationState }>({ key: '', state: IDLE_STATE });
  useEffect(() => {
    if (!key || !productId) return;
    let dead = false;
    const made: string[] = [];
    (async () => {
      try {
        const items = await loadRemoteGallery(productId);
        if (dead) return;
        if (items.length === 0) { setHeld({ key, state: { status: 'empty', srcs: [] } }); return; }
        const presented = items.map((i) => {
          const url = URL.createObjectURL(i.blob);
          made.push(url);
          return { url, mimeType: i.mimeType, mediaId: i.mediaId, sortOrder: i.sortOrder, isPrimary: i.isPrimary };
        });
        setHeld({ key, state: { status: 'media', srcs: presented.map((p) => p.url), items: presented } });
      } catch (e) {
        if (!dead) setHeld({ key, state: { status: 'error', code: e instanceof Error ? e.message : 'REMOTE_MEDIA_FAILED', srcs: [] } });
      }
    })();
    return () => {
      dead = true;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [key, productId]);
  if (enabled && productId && legacyState) return legacyState;
  if (!key) return IDLE_STATE;
  return held.key === key ? held.state : LOADING_STATE;
}

function useLocalPresentation(
  productId: string | undefined,
  tenantId: string | undefined,
  branchId: string | undefined,
  enabled: boolean,
  reloadNonce: number,
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
    // `reloadNonce` is a dep so a post-save bump re-resolves the SAME key: the
    // controller revokes the old URLs exactly once and shows the new gallery.
  }, [productId, tenantId, branchId, enabled, reloadNonce]);

  return state;
}
