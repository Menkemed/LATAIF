// ════════════════════════════════════════════════════════════════════════════
// REPAIR-HOVER — das Titelbild (HAUPTBILD, nicht die Vorschau) einer Reparatur für die große Hover-Karte.
//
// Geladen wird erst, wenn die Karte erscheint (der Hook läuft nur in der gezeigten Karte), und nur EIN Bild —
// nie die ganze Galerie. Das Ergebnis liegt im gemeinsamen RAM-Cache der Kartenbilder (`card-image-cache`,
// eigener Schlüssel je Reparatur), mit Fingerabdruck (Kennung + Inhalt): ein zweites Überfahren zeigt es sofort,
// eine geänderte Galerie lädt neu. Primary: lokale Verknüpfung → geprüfter Rohweg (`media_read_verified_raw`).
// PC2: `repairs.get` nennt den Schlüssel → `/api/media` mit Ausweis. Altbestand ohne Medienkern: die alte
// Daten-URL der Spalte (gelesen, nie geschrieben). Nur lesend.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { readsFromPrimary } from '@/core/data/primary-source';
import { sharedCardImageCache } from '@/core/media/card-image-cache';
import { pickRepairCover, repairCoverCacheKey, repairCoverFingerprint } from '@/core/repairs/repair-hover';

export type RepairCoverState =
  | { status: 'loading' }
  | { status: 'media'; url: string }
  | { status: 'legacy'; url: string }
  | { status: 'empty' }
  | { status: 'error'; code: string };

type Load = { kind: 'cached'; url: string } | { kind: 'media'; url: string } | { kind: 'legacy'; url: string } | { kind: 'empty' };
const inflight = new Map<string, Promise<Load>>();

/** Aufnehmen mit Übergabe (wie die Artikelkarten): gehalten, bis die wartende Karte selbst hält. */
function putHanded(key: string, blob: Blob, fingerprint: string): string {
  const cache = sharedCardImageCache();
  const { url } = cache.put(key, blob, fingerprint, true);
  setTimeout(() => cache.release(url), 0);
  return url;
}

async function loadLocal(repairId: string, legacy: readonly string[]): Promise<Load> {
  const [{ repairPhotoRefs }, { OriginalMediaTransport }] = await Promise.all([
    import('@/core/repairs/repair-media'),
    import('@/core/media/gateway'),
  ]);
  const key = repairCoverCacheKey(repairId);
  const ref = pickRepairCover(repairPhotoRefs(repairId));
  if (!ref) {
    sharedCardImageCache().delete(key);
    return legacy[0] ? { kind: 'legacy', url: legacy[0] } : { kind: 'empty' };
  }
  const fp = repairCoverFingerprint(ref);
  const hit = sharedCardImageCache().get(key);
  if (hit && hit.fingerprint === fp) return { kind: 'cached', url: hit.url };
  const bytes = await new OriginalMediaTransport().readVerifiedRaw({ tenantScope: ref.main.storageKey.split('/')[0], hash: ref.main.hash, extension: ref.main.extension });
  return { kind: 'media', url: putHanded(key, new Blob([bytes as BlobPart], { type: ref.main.mimeType || 'image/jpeg' }), fp) };
}

async function loadRemote(repairId: string): Promise<Load> {
  const [{ remoteRead }, { clientConfig }] = await Promise.all([import('@/core/bridge/remote-read'), import('@/core/bridge/client-mode')]);
  const key = repairCoverCacheKey(repairId);
  const detail = await remoteRead<{ mediaKeys?: string[]; images?: string[] }>('repairs.get', { id: repairId });
  const first = (detail.mediaKeys ?? [])[0];
  if (!first) {
    sharedCardImageCache().delete(key);
    const old = (detail.images ?? [])[0];
    return old ? { kind: 'legacy', url: old } : { kind: 'empty' };
  }
  const hit = sharedCardImageCache().get(key);
  if (hit && hit.fingerprint === first) return { kind: 'cached', url: hit.url };
  const c = clientConfig();
  if (!c?.token) throw new Error('NOT_AUTHENTICATED');
  const res = await fetch(`${c.serverUrl}/api/media?key=${encodeURIComponent(first)}`, { headers: { Authorization: `Bearer ${c.token}` } });
  if (!res.ok) throw new Error(`MEDIA_UNAVAILABLE_${res.status}`);
  return { kind: 'media', url: putHanded(key, await res.blob(), first) };
}

function load(repairId: string, legacy: readonly string[]): Promise<Load> {
  const remote = readsFromPrimary();
  const k = `${remote ? 'r' : 'l'}|${repairId}`;
  let p = inflight.get(k);
  if (!p) {
    p = (remote ? loadRemote(repairId) : loadLocal(repairId, legacy)).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

/** Das Titelbild einer Reparatur — nur solange `repairId` gesetzt ist (die Karte gezeigt wird). */
export function useRepairCoverImage(repairId: string | null, legacy: readonly string[] = []): RepairCoverState {
  const [state, setState] = useState<RepairCoverState>({ status: 'loading' });
  const legacyFirst = legacy[0] ?? '';
  useEffect(() => {
    if (!repairId) return;
    let alive = true;
    let held: string | null = null;
    setState({ status: 'loading' });
    load(repairId, legacyFirst ? [legacyFirst] : [])
      .then((r) => {
        if (!alive) return;
        if (r.kind === 'cached' || r.kind === 'media') {
          sharedCardImageCache().acquire(r.url); held = r.url;
          setState({ status: 'media', url: r.url });
        } else if (r.kind === 'legacy') setState({ status: 'legacy', url: r.url });
        else setState({ status: 'empty' });
      })
      .catch((e: unknown) => { if (alive) setState({ status: 'error', code: (e as { message?: string })?.message ?? 'MEDIA_FAILED' }); });
    return () => { alive = false; if (held) sharedCardImageCache().release(held); };
  }, [repairId, legacyFirst]);
  return state;
}
