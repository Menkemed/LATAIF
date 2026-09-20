// ════════════════════════════════════════════════════════════════════════════
// MEDIA — Bytes zum ANZEIGEN holen, auf beiden Rechnern, auf EINEM Weg.
//
// Gespeichert ist überall eine Referenz. Zum Zeigen braucht die Maske Bytes, und dafür gibt es
// genau zwei geprüfte Wege:
//
//   Primary  → `media_read_verified` (Rust prüft Pfad, Größe und Inhalt-Hash)
//   PC2      → `/api/media` mit Ausweis — das Tor entscheidet (Mandant, Filiale, Besitzer, Rolle,
//              Klasse, aktive Verknüpfung); der Schlüssel allein berechtigt zu nichts.
//
// Diese beiden Wege stehen hier EINMAL. Ein Ausweisdokument, ein Posteingangsfoto und alles
// Weitere unterscheiden sich darin, WAS sie zeigen dürfen — nicht darin, wie Bytes zu holen sind;
// eine zweite Umsetzung wäre eine zweite Stelle, an der ein Tor vergessen werden kann.
//
// Es entsteht nirgends eine Daten-URL, die liegen bleibt: kein Zustand, kein Zwischenspeicher,
// keine Spalte. Wer die Maske verlässt, gibt die Objekt-URL wieder frei.
// ════════════════════════════════════════════════════════════════════════════
import { readsFromPrimary } from '@/core/data/primary-source';
import { clientConfig } from '@/core/bridge/client-mode';
import { ORIGINAL_EXTENSIONS, OriginalMediaTransport, TauriMediaGateway } from './gateway';

/** Was zum Holen genügt: der Ablageschlüssel (PC2) und der Inhalt-Hash (Primary). */
export interface VerifiedMediaRef {
  key: string;
  hash: string;
  extension: string;
}

/** Eine Objekt-URL, die nur solange lebt wie das Fenster. */
export interface VerifiedMediaView {
  url: string;
  revocable: boolean;
}

/** Objekt-URLs freigeben — genau einmal, beim Verlassen der Maske. */
export function revokeVerifiedMedia(view: { url: string; revocable: boolean } | null | undefined): void {
  if (view?.revocable) { try { URL.revokeObjectURL(view.url); } catch { /* schon weg */ } }
}

async function vonPrimary(ref: VerifiedMediaRef): Promise<VerifiedMediaView> {
  const scope = ref.key.split('/')[0];
  // MEDIA-DOCUMENTS — ein ORIGINAL (PDF) kommt über den Rohweg zurück. Der alte JSON-Weg weist es
  // ausdrücklich ab (`json_read_allowed`): eine 25-MiB-Datei als Zahlenfeld wäre unbrauchbar. Die
  // Prüfung ist dieselbe — Pfad, Größe, Inhalt-Hash — nur der Transport ist ein anderer.
  if (ORIGINAL_EXTENSIONS.includes(ref.extension as never)) {
    const bytes = await new OriginalMediaTransport().readVerifiedRaw({ tenantScope: scope, hash: ref.hash, extension: ref.extension });
    return { url: URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeOf(ref.extension) })), revocable: true };
  }
  const gateway = new TauriMediaGateway();
  const m = await gateway.readVerifiedMedia({ tenantScope: scope, hash: ref.hash, extension: ref.extension });
  const blob = new Blob([m.bytes as unknown as BlobPart], { type: m.mime_type || 'image/jpeg' });
  return { url: URL.createObjectURL(blob), revocable: true };
}

/** Der Typ, den der Speicher für diese Endung führt — nicht der, den irgendwer behauptet. */
function mimeOf(extension: string): string {
  return extension === 'pdf' ? 'application/pdf' : 'image/jpeg';
}

async function vonClient(ref: VerifiedMediaRef, fetchFn: typeof fetch, fehlerPrefix: string): Promise<VerifiedMediaView> {
  const c = clientConfig();
  if (!c?.token) throw new Error('NOT_AUTHENTICATED');
  const res = await fetchFn(`${c.serverUrl}/api/media?key=${encodeURIComponent(ref.key)}`, {
    headers: { Authorization: `Bearer ${c.token}` },
  });
  // Ein abgewiesener Zugriff ist ein Fehler, nie ein leeres Bild: „nicht da" und „darfst du nicht"
  // sähen sonst gleich aus, und niemand wüsste, welches von beidem gilt.
  if (!res.ok) throw new Error(`${fehlerPrefix}_${res.status}`);
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), revocable: true };
}

/** Die Bytes einer Referenz anzeigefertig machen — über den Weg, der für DIESEN Rechner gilt. */
export function loadVerifiedMedia(
  ref: VerifiedMediaRef,
  fetchFn: typeof fetch = fetch,
  fehlerPrefix = 'MEDIA_UNAVAILABLE',
): Promise<VerifiedMediaView> {
  return readsFromPrimary() ? vonClient(ref, fetchFn, fehlerPrefix) : vonPrimary(ref);
}
