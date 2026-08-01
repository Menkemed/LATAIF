// ════════════════════════════════════════════════════════════════════════════
// MEDIA-CONSUMERS-EXPORT — pure, dependency-free export-image helpers.
//
// Split out from `product-image-export.ts` (which pulls in the DB/gateway) so the
// deterministic decode/mime logic is node-testable in isolation. NO imports, no
// DB, no Tauri, no Object-URL — just bytes math.
// ════════════════════════════════════════════════════════════════════════════

export type ExportImageExt = 'png' | 'jpeg';
export interface ExportImage {
  /** A fresh, plain-ArrayBuffer-backed copy — safe for ExcelJS regardless of the
   *  source buffer (the IPC bridge may hand back a SharedArrayBuffer view). */
  bytes: Uint8Array;
  extension: ExportImageExt;
}

/** Authorised media scope for the canonical resolver (DB-derived tenant/branch). */
export interface ExportMediaScope {
  tenantId: string | undefined;
  branchId: string | undefined;
}

/** Map a resolved media MIME to an ExcelJS-embeddable extension, or null when the
 *  format is not one ExcelJS/the export supports (→ image is skipped, row kept). */
export function extFromMime(mime: string): ExportImageExt | null {
  const m = (mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpeg';
  return null;
}

/** Decode a `data:image/(png|jpeg);base64,…` URL to embeddable bytes. Any other
 *  shape (empty, http URL, unsupported mime, malformed base64) → null.
 *  `decode` is injected so the browser (`atob`) and node (`Buffer`) can each
 *  supply a base64 decoder without this module importing either. */
export function decodeImageDataUrl(
  src: string | undefined,
  decode: (b64: string) => Uint8Array,
): ExportImage | null {
  if (!src) return null;
  const m = src.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!m) return null;
  const extension: ExportImageExt = m[1].toLowerCase().startsWith('jp') ? 'jpeg' : 'png';
  try {
    const bytes = decode(m[2]);
    if (!bytes || bytes.length === 0) return null;
    return { bytes, extension };
  } catch {
    return null;
  }
}

/** Browser base64 → bytes (via `atob`). */
export function atobToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
