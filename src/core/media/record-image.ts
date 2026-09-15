// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B PP-12 — EIN Bildweg für Belegbilder.
//
// Reparatur-, Altgold-, Ausweis-, Einkaufs- und Auftragsfotos wohnen in ihrer Zeile (Daten-URL) —
// das Artikelbild dagegen im Medienspeicher. Bisher kamen die Belegbilder dort ohne Byte-Grenze an
// (Browser-Kompression als Ziel, keine Prüfung am Primary). Jetzt geht jedes NEUE vor dem Speichern
// durch DENSELBEN Normalisierer wie das Artikelbild (Rust `normalize_stock_image`, s.
// `media::record_image`): JPEG, ≤ 100 000 B, ≤ 1600 px, EXIF-Ausrichtung angewandt, Metadaten weg —
// oder ein Nein mit festem Code.
//
//   • am Primary: `normalizeRecordImages` (Tauri `media_normalize_record_image`);
//   • vom zweiten Rechner: beim Abholen aus der Ablage (`staging_media_read_record`, s.
//     `readStagedAsRecordImages`) — dieselbe Prüfung, dasselbe Ergebnis.
//
// Ein schon gespeichertes Foto wird NIE neu gerechnet (`keep`): bestehende Bilder bleiben Byte für
// Byte, wie sie sind — keine stille Umwandlung vorhandener Medien.
// ════════════════════════════════════════════════════════════════════════════

/** Die Grenze des gespeicherten Belegbilds — dieselbe wie das Hauptbild im Medienspeicher. */
export const RECORD_IMAGE_MAX_BYTES = 100_000;
export const RECORD_IMAGE_MAX_DIM = 1600;

export class RecordImageRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RecordImageRejected';
  }
}

export interface NormalizedRecordImage {
  mime: string;
  dataBase64: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Bekommt den Base64-Inhalt EINES Fotos (und den Typ, den seine Daten-URL behauptet — der echte
 * Normalisierer glaubt ihn nicht, er liest die Bytes), gibt das gespeicherte zurück.
 */
export type RecordImageNormalizer = (dataBase64: string, claimedMime: string) => Promise<NormalizedRecordImage>;

async function invokeNormalize(dataBase64: string): Promise<NormalizedRecordImage> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NormalizedRecordImage>('media_normalize_record_image', { dataBase64 });
}

let normalizer: RecordImageNormalizer = invokeNormalize;

/**
 * Nur für Tests: Node hat kein Tauri. Ohne Ersatz scheitert das Normalisieren dort — gewollt: ein
 * Foto, das nicht durch den Normalisierer ging, wird nicht gespeichert. `null` stellt den echten her.
 */
export function setRecordImageNormalizer(fn: RecordImageNormalizer | null): void {
  normalizer = fn ?? invokeNormalize;
}

const PHOTO_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;

export function recordImageCode(e: unknown): string {
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
  const m = /\b(MEDIA_[A-Z_]+)\b/.exec(raw);
  return m ? m[1] : 'RECORD_IMAGE_NOT_STORED';
}

/**
 * Die Fotos eines Belegs, so wie sie gespeichert werden. `keep` nennt die schon gespeicherten
 * Fassungen: sie bleiben unverändert (auch ein Altbild über 100 KB wird nicht umgerechnet).
 */
export async function normalizeRecordImages(
  urls: readonly string[] | undefined, opts: { keep?: Iterable<string> } = {},
): Promise<string[]> {
  const keep = new Set(opts.keep ?? []);
  const out: string[] = [];
  for (const url of urls ?? []) {
    if (keep.has(url)) { out.push(url); continue; }
    if (typeof url !== 'string' || !PHOTO_DATA_URL.test(url)) {
      throw new RecordImageRejected('RECORD_IMAGE_NOT_A_PHOTO', 'a photo is stored as an image — this is not one');
    }
    let n: NormalizedRecordImage;
    try {
      n = await normalizer(url.slice(url.indexOf(',') + 1), url.slice(5, url.indexOf(';')));
    } catch (e) {
      const code = recordImageCode(e);
      throw new RecordImageRejected(code, recordImageMessage(code));
    }
    out.push(`data:${n.mime};base64,${n.dataBase64}`);
  }
  return out;
}

/** Ein einzelnes Foto (Ausweisbild). `keep` ist die gespeicherte Fassung, falls es eine gibt. */
export async function normalizeRecordImage(url: string, keep?: string | null): Promise<string> {
  const [one] = await normalizeRecordImages([url], { keep: keep ? [keep] : [] });
  return one;
}

/**
 * Der Artikelentwurf eines Einkaufs oder Auftrags („New Item"): seine Fotos landen mit dem Artikel in
 * `products.images` bzw. im Entwurf des Auftrags — also dieselbe Behandlung wie jedes Belegbild.
 */
export async function normalizeSpecImages<T extends { images?: string[] }>(spec: T | undefined): Promise<T | undefined> {
  if (!spec || !Array.isArray(spec.images) || spec.images.length === 0) return spec;
  return { ...spec, images: await normalizeRecordImages(spec.images) };
}

/** Was der Mensch liest, wenn ein Foto nicht gespeichert werden kann. */
export function recordImageMessage(code: string): string {
  switch (code) {
    case 'MEDIA_IMAGE_DETAIL_INSUFFICIENT':
      return 'This photo cannot be stored within 100 KB without losing its detail — take a closer photo of the part that matters.';
    case 'MEDIA_IMAGE_TOO_LARGE':
      return 'This photo is too large (at most 25 MB, 8192 px per side, 24 megapixels).';
    case 'MEDIA_UNSUPPORTED_CONTENT':
      return 'This file is not a photo (JPEG, PNG or WebP).';
    case 'MEDIA_IMAGE_DECODE_FAILED':
      return 'This photo could not be read — the file is damaged.';
    default:
      return `This photo could not be stored (${code}).`;
  }
}

/** SHA-256 der Bytes einer Daten-URL — dieselbe Kennung, die die Ablage einem Foto gibt. */
export async function sha256OfDataUrl(url: string): Promise<string> {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
