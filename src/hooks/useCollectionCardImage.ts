// ════════════════════════════════════════════════════════════════════════════
// COLLECTIONS-S1/S2 — das Kartenbild eines Artikels: RAM-Cache + Laden erst bei Sichtbarkeit.
//
// • Liegt das Bild im Cache (`core/media/card-image-cache`), erscheint es SOFORT — auch nach
//   „Artikel öffnen → zurück" oder einem Kategorienwechsel. Danach prüft die Karte, sobald sie
//   sichtbar ist, nur den Fingerabdruck der Galerie (Primary: eine Abfrage ohne Bildbytes; PC2: eine
//   Auskunft `products.get`, kein Bild). Weicht er ab (Bearbeitung, Mobile-Upload, Restore, ein
//   anderer Rechner), wird neu geladen.
// • Ohne Cache lädt die Karte erst, wenn sie (bald) sichtbar ist (`near`), und hält danach nur das
//   Kartenbild — nie die Galerie.
// • Gleiche Ladeanfragen mehrerer Karten (z. B. Raster + Hover-Karte) laufen nur einmal.
//
// Der Zustand ist derselbe `PresentationState` wie bisher, damit `decideCollectionThumb` und der
// begrenzte Pending-Retry unverändert gelten. Nur lesend; kein Schreiben in Store oder Datenbank.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readsFromPrimary } from '@/core/data/primary-source';
import { sharedCardImageCache } from '@/core/media/card-image-cache';
import { IDLE_STATE, type PresentationState } from '@/core/media/presentation';

type CardLoad =
  | { kind: 'same' }
  | { kind: 'media'; url: string; fingerprint: string }
  | { kind: 'state'; state: PresentationState };

const LOADING: PresentationState = { status: 'loading', srcs: [] };
const inflight = new Map<string, Promise<CardLoad>>();
let lastEpoch: number | null = null;

function mediaState(url: string): PresentationState {
  return { status: 'media', srcs: [url], items: [{ url, mimeType: '', mediaId: '', sortOrder: 0, isPrimary: true }] };
}

function errorState(e: unknown, fallback: string): PresentationState {
  const code = (e as { code?: string; message?: string })?.code ?? (e as { message?: string })?.message ?? fallback;
  return { status: 'error', code, srcs: [] };
}

async function loadLocal(productId: string, tenantId: string, branchId: string, known: string | undefined): Promise<CardLoad> {
  const [{ acquireDbLease }, { ProductMediaResolver }, { TauriMediaGateway }] = await Promise.all([
    import('@/core/db/database'),
    import('@/core/media/product-media-resolver'),
    import('@/core/media/gateway'),
  ]);
  const lease = await acquireDbLease();
  try {
    // Eine neue DB-Epoche (Restore/Neuladen) macht jeden alten Eintrag wertlos.
    if (lastEpoch !== null && lastEpoch !== lease.epoch) sharedCardImageCache().clear();
    lastEpoch = lease.epoch;
    const resolver = new ProductMediaResolver({
      dbProvider: () => lease.db,
      gateway: new TauriMediaGateway(),
      tenantId,
      branchId,
    });
    // Fingerabdruck und Auflösung sehen dieselbe Datenbank: zwischen beiden liegt kein `await`.
    const fingerprint = resolver.galleryFingerprint(productId);
    if (known !== undefined && fingerprint === known) return { kind: 'same' };
    const r = await resolver.resolvePrimaryProductMedia(productId);
    switch (r.kind) {
      case 'media': {
        const it = r.items[0];
        const blob = new Blob([new Uint8Array(it.bytes)], { type: it.mimeType });
        return { kind: 'media', url: putHanded(productId, blob, fingerprint), fingerprint };
      }
      case 'legacy':
        sharedCardImageCache().delete(productId);
        return { kind: 'state', state: { status: 'legacy', srcs: r.items.slice(0, 1) } };
      case 'none':
        sharedCardImageCache().delete(productId);
        return { kind: 'state', state: { status: 'empty', srcs: [] } };
      case 'pending':
        return { kind: 'state', state: { status: 'pending', srcs: [] } };
      default:
        sharedCardImageCache().delete(productId);
        return { kind: 'state', state: { status: 'error', code: r.code, srcs: [] } };
    }
  } finally {
    lease.release();
  }
}

async function loadRemote(productId: string, known: string | undefined): Promise<CardLoad> {
  const { loadRemoteCardImage } = await import('@/core/media/client-media-source');
  const r = await loadRemoteCardImage(productId, known);
  if (r.kind === 'same') return { kind: 'same' };
  if (r.kind === 'empty') {
    sharedCardImageCache().delete(productId);
    return { kind: 'state', state: { status: 'empty', srcs: [] } };
  }
  return { kind: 'media', url: putHanded(productId, r.blob, r.fingerprint), fingerprint: r.fingerprint };
}

/**
 * Aufnehmen mit Übergabe: der Eintrag bleibt gehalten, bis alle wartenden Karten ihn in ihrem
 * `.then` (Microtasks) selbst halten; die Übergabe endet im nächsten Task.
 */
function putHanded(productId: string, blob: Blob, fingerprint: string): string {
  const cache = sharedCardImageCache();
  const { url } = cache.put(productId, blob, fingerprint, true);
  setTimeout(() => cache.release(url), 0);
  return url;
}

function loadCard(remote: boolean, scope: string, productId: string, tenantId: string, branchId: string, known: string | undefined): Promise<CardLoad> {
  const key = `${scope}|${productId}|${known ?? ''}`;
  let p = inflight.get(key);
  if (!p) {
    p = (remote ? loadRemote(productId, known) : loadLocal(productId, tenantId, branchId, known))
      .catch((e): CardLoad => {
        sharedCardImageCache().delete(productId);
        return { kind: 'state', state: errorState(e, remote ? 'REMOTE_MEDIA_FAILED' : 'MEDIA_PRESENTATION_FAILED') };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

interface View {
  k: string;
  url?: string;
  fingerprint?: string;
  state: PresentationState;
}

/**
 * @param enabled     autorisierter Schlüssel (Mandant + Filiale + Artikel) vorhanden
 * @param near        Karte ist sichtbar oder bald sichtbar (S2) — vorher keine Abfrage
 * @param reloadNonce erhöhen erzwingt eine neue Prüfung (begrenzter Pending-Retry)
 */
export function useCollectionCardImage(
  productId: string,
  tenantId: string | undefined,
  branchId: string | undefined,
  enabled: boolean,
  near: boolean,
  reloadNonce: number,
): PresentationState {
  const remote = readsFromPrimary();
  const scope = `${remote ? 'remote' : 'local'}|${tenantId ?? ''}|${branchId ?? ''}`;
  const k = `${scope}|${productId}`;
  const cache = sharedCardImageCache();

  const initial = (): View => {
    if (!enabled) return { k, state: IDLE_STATE };
    cache.setScope(scope);
    const hit = cache.get(productId);
    return hit ? { k, url: hit.url, fingerprint: hit.fingerprint, state: mediaState(hit.url) } : { k, state: IDLE_STATE };
  };
  const [view, setView] = useState<View>(initial);
  // Anderer Artikel/Scope bei derselben Karte: neu ableiten (React-Muster „state from props").
  let current = view;
  if (view.k !== k) {
    current = initial();
    setView(current);
  }
  const viewRef = useRef(current);
  viewRef.current = current;

  // Die gezeigte Cache-URL darf nicht unter der Karte widerrufen werden: die Karte hält genau die
  // URL, die sie zeigt (neue zuerst halten, dann die alte loslassen), und lässt beim Abbau los.
  const pinned = useRef<string | undefined>(undefined);
  const pinTo = (url: string | undefined): void => {
    const prev = pinned.current;
    if (prev === url) return;
    if (url) cache.acquire(url);
    pinned.current = url;
    if (prev) cache.release(prev);
  };
  const shownUrl = current.url;
  useLayoutEffect(() => {
    pinTo(shownUrl);
  });
  useLayoutEffect(() => () => pinTo(undefined), []);

  useEffect(() => {
    if (!enabled || !near || !tenantId || !branchId) return;
    let dead = false;
    const known = viewRef.current.fingerprint;
    if (!viewRef.current.url) {
      setView((v) => (v.k === k && v.state.status !== 'loading' ? { k, state: LOADING } : v));
    }
    void loadCard(remote, scope, productId, tenantId, branchId, known).then((res) => {
      if (dead || res.kind === 'same') return;
      if (res.kind === 'media') {
        pinTo(res.url); // noch in der Übergabe — erst danach darf sie enden
        setView({ k, url: res.url, fingerprint: res.fingerprint, state: mediaState(res.url) });
      } else {
        setView({ k, state: res.state });
      }
    });
    return () => {
      dead = true;
    };
  }, [k, scope, remote, productId, tenantId, branchId, enabled, near, reloadNonce]);

  return current.state;
}
