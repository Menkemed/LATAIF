// ════════════════════════════════════════════════════════════════════════════
// MEDIA-IDENTITY §10 — ein Ausweisdokument ANZEIGEN, auf beiden Rechnern.
//
// Gespeichert ist eine Referenz. Zum Zeigen holt die Maske die Bytes über einen geprüften Weg und
// macht daraus eine Objekt-URL, die nur solange lebt wie das Fenster:
//
//   Primary  → `media_read_verified` (Rust prüft Pfad, Größe und Inhalt-Hash)
//   PC2      → `/api/media` mit Ausweis — das Tor entscheidet (Mandant, Filiale, Besitzer, Rolle,
//              Klasse, aktive Verknüpfung); der Schlüssel allein berechtigt zu nichts.
//
// Es entsteht nirgends eine Daten-URL, die irgendwo liegen bleibt: kein Zustand, kein Cache, keine
// Spalte. Wer die Maske verlässt, gibt die Objekt-URL wieder frei.
// ════════════════════════════════════════════════════════════════════════════
import { readsFromPrimary } from '@/core/data/primary-source';
import { clientConfig } from '@/core/bridge/client-mode';
import { TauriMediaGateway } from '@/core/media/gateway';
import type { IdentityDocumentRef, PurchaseIdentityReference } from '@/core/models/types';

export interface IdentityPhotoView {
  /** Die stabile Kennung des Mediums — leer, wenn es der Altbestand einer Spalte ist. */
  mediaId: string;
  /** Was ein `<img src>` anzeigen kann. */
  url: string;
  /** true: eine Objekt-URL, die wieder freigegeben werden muss. */
  revocable: boolean;
  /** true: das Dokument gehört dem verknüpften Kunden, nicht diesem Lieferanten. */
  fromLinkedCustomer: boolean;
}

/** Objekt-URLs freigeben — genau einmal, beim Verlassen der Maske. */
export function revokeIdentityPhoto(view: IdentityPhotoView | null): void {
  if (view?.revocable) { try { URL.revokeObjectURL(view.url); } catch { /* schon weg */ } }
}

async function fromPrimary(ref: IdentityDocumentRef): Promise<IdentityPhotoView> {
  const gateway = new TauriMediaGateway();
  const scope = ref.key.split('/')[0];
  const m = await gateway.readVerifiedMedia({ tenantScope: scope, hash: ref.hash, extension: ref.extension });
  const blob = new Blob([m.bytes as unknown as BlobPart], { type: m.mime_type || 'image/jpeg' });
  return { mediaId: ref.mediaId, url: URL.createObjectURL(blob), revocable: true, fromLinkedCustomer: ref.fromLinkedCustomer };
}

async function fromClient(ref: IdentityDocumentRef, fetchFn: typeof fetch): Promise<IdentityPhotoView> {
  const c = clientConfig();
  if (!c?.token) throw new Error('NOT_AUTHENTICATED');
  const res = await fetchFn(`${c.serverUrl}/api/media?key=${encodeURIComponent(ref.key)}`, {
    headers: { Authorization: `Bearer ${c.token}` },
  });
  // Ein abgewiesener Zugriff ist ein Fehler, nie ein leeres Bild: „nicht da" und „darfst du nicht"
  // sähen sonst gleich aus, und niemand wüsste, welches von beidem gilt.
  if (!res.ok) throw new Error(`IDENTITY_MEDIA_UNAVAILABLE_${res.status}`);
  const blob = await res.blob();
  return { mediaId: ref.mediaId, url: URL.createObjectURL(blob), revocable: true, fromLinkedCustomer: ref.fromLinkedCustomer };
}

/**
 * MEDIA-IDENTITY §7 — der Nachweis EINES EINKAUFS: genau die Fassung, die beim Kauf galt.
 *
 * Dieselben zwei Wege, aber gegen die eingefrorenen Angaben statt gegen den heutigen Stand. Am
 * Primary findet der Inhalt-Hash die Datei — der Speicher ist inhaltsadressiert, eine abgelöste
 * Fassung liegt also weiterhin unter ihrem eigenen Namen. Auf PC2 entscheidet dasselbe Tor, das
 * dafür eine ausdrückliche Regel hat: der Beleg dieser Filiale muss genau diese Fassung nennen.
 */
export async function loadPurchaseIdentityPhoto(
  identity: PurchaseIdentityReference | null | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<IdentityPhotoView | null> {
  if (!identity) return null;
  const ref: IdentityDocumentRef = {
    mediaId: identity.mediaId,
    key: identity.storageKey,
    thumbKey: null,
    hash: identity.blobHash,
    extension: identity.extension,
    generationNo: identity.generationNo,
    sourceOwnerType: identity.ownerType,
    sourceOwnerId: identity.ownerId,
    fromLinkedCustomer: identity.ownerType === 'customer',
  };
  return readsFromPrimary() ? fromClient(ref, fetchFn) : fromPrimary(ref);
}

/**
 * Dieselbe Fassung als Daten-URL — NUR für den Druck.
 *
 * Ein PDF kann keine Objekt-URL einbetten, also müssen die Bytes einmal hineinkopiert werden. Das
 * ist keine Speicherung: die Zeichenkette lebt so lange wie das erzeugte Dokument und landet in
 * keiner Spalte, keinem Zustand und keinem Zwischenspeicher.
 */
export async function purchaseIdentityDataUrl(
  identity: PurchaseIdentityReference | null | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const view = await loadPurchaseIdentityPhoto(identity, fetchFn);
  if (!view) return null;
  try {
    const blob = await (await fetch(view.url)).blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('IDENTITY_READ_FAILED'));
      r.readAsDataURL(blob);
    });
  } finally {
    revokeIdentityPhoto(view);
  }
}

/**
 * Das Ausweisdokument anzeigefertig machen. `legacy` ist die alte Daten-URL aus der
 * Lieferantenspalte — sie gilt nur, wenn es gar keine Referenz gibt.
 */
export async function loadIdentityPhoto(
  ref: IdentityDocumentRef | null | undefined,
  legacy?: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<IdentityPhotoView | null> {
  if (!ref) {
    return legacy ? { mediaId: '', url: legacy, revocable: false, fromLinkedCustomer: false } : null;
  }
  return readsFromPrimary() ? fromClient(ref, fetchFn) : fromPrimary(ref);
}
