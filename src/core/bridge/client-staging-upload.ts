// CENTRAL-C3C — wie der Client seine Bilder loswird, BEVOR er einen Auftrag schickt.
//
// Ein Auftrag ist eine Nachricht. 25 MiB Bild gehören nicht hinein: sie blockierten die eine
// Warteschlange des Primary, während dort auch Rechnungen und Kunden warten. Also zuerst die
// Bytes, dann der Auftrag.
//
// Die Stelle, an die hier geschickt wird, entscheidet nichts (`/api/staging/media`): sie nimmt
// Bytes und antwortet mit einer Kennung — dem SHA-256 des Inhalts, VOM SERVER berechnet. Deshalb
// hat dieses Modul auch kein Feld für einen Dateinamen, einen Ordner oder einen Zielpfad; es gibt
// nichts, worin ein Client ein Ziel nennen könnte, und damit nichts zu missbrauchen.
//
// Und deshalb ist ein zweites Hochladen desselben Bildes harmlos: derselbe Inhalt ergibt dieselbe
// Kennung, und der Server legt keine zweite Ablage an.

import { clientConfig, setClientToken } from './client-mode';
import { ERR_UNAVAILABLE } from './remote-read';

/** Was der Server über eine angenommene Ablage sagt. Die Kennung vergibt ER. */
export interface StagedImage {
  stagingId: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

export class StagingUploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StagingUploadError';
    this.code = code;
  }
}

/** Nur die Typen, die der Primary auch annimmt — geprüft wird dort an den Magic Bytes. */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * Legt EIN Bild ab und gibt seine Kennung zurück. Wirft mit einem Code — die Oberfläche zeigt ihn,
 * statt ein Bild still zu verlieren.
 */
export async function stageImage(
  file: { type: string; arrayBuffer(): Promise<ArrayBuffer> },
  fetchFn: typeof fetch = fetch,
): Promise<StagedImage> {
  const c = clientConfig();
  if (!c) throw new StagingUploadError(ERR_UNAVAILABLE, 'no server configured for this client');
  if (!c.token) throw new StagingUploadError('NOT_AUTHENTICATED', 'not signed in');

  const bytes = new Uint8Array(await file.arrayBuffer());
  let res: Response;
  try {
    res = await fetchFn(`${c.serverUrl}/api/staging/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ mime: file.type, dataBase64: base64(bytes) }),
    });
  } catch (e) {
    throw new StagingUploadError(ERR_UNAVAILABLE, `no answer from the server: ${String(e)}`);
  }

  if (res.status === 401 || res.status === 403) {
    setClientToken(null);
    throw new StagingUploadError('NOT_AUTHENTICATED', 'the session is no longer valid');
  }
  let body: { stagingId?: string; mime?: string; bytes?: number; width?: number; height?: number; code?: string };
  try {
    body = await res.json() as typeof body;
  } catch {
    throw new StagingUploadError('UNREADABLE_ANSWER', `unreadable answer (${res.status})`);
  }
  if (!res.ok || typeof body.stagingId !== 'string') {
    // Der Primary sagt, warum er das Bild nicht will (falscher Typ, zu groß, kaputt). Diesen Code
    // bekommt der Benutzer zu sehen — „Upload fehlgeschlagen" wäre keine Auskunft.
    throw new StagingUploadError(body.code ?? `HTTP_${res.status}`, 'the primary refused this image');
  }
  return {
    stagingId: body.stagingId,
    mime: String(body.mime ?? file.type),
    bytes: Number(body.bytes ?? bytes.length),
    width: Number(body.width ?? 0),
    height: Number(body.height ?? 0),
  };
}
