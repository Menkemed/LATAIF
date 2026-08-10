// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §13/§14 — blob-free audit values.
//
// The audit log must answer "which product, which action, when, what changed" —
// not "here are 450 KB of JPEG again". Before this module every product save
// copied the full base64 image into `audit_log.new_value`; a legacy install
// carried tens of megabytes of duplicated photo bytes in its audit history.
//
// The fix is a single pure substitution applied at the ONE place audit values are
// serialised: an inline `data:<mime>;base64,…` payload becomes a compact, stable
// DESCRIPTOR — kind, mime, decoded byte size and a content digest. Audit truth is
// preserved exactly where it matters:
//   • a changed image → different digest → the change is still visible
//   • an unchanged image → identical digest → still provably unchanged
//   • add / remove / replace over a list stays legible slot by slot
// What is lost is only the ability to re-render the picture FROM THE AUDIT ROW —
// which was never the audit's job; the durable media store owns the bytes.
//
// The digest is a 64-bit IDENTITY digest over the exact base64 payload, built as
// two independent 32-bit rolling hashes (FNV-1a and djb2-xor) concatenated. It is
// deliberately NOT cryptographic: an audit write is synchronous and sits inside a
// SQL transaction, so the digest must be sync, allocation-free and fast over a
// ~600 KB payload — a BigInt 64-bit mixer measured ~64 ms per image, which would
// tax every save. Two `Math.imul` passes cost ~1 ms. It is never a security
// boundary and never compared against the media store's SHA-256 blob hashes.
//
// Applies to NEW writes only. Existing history is never rewritten — §13 is
// explicit that retention of past audit rows is a separate, separately-proven
// decision.
// ════════════════════════════════════════════════════════════════════════════

/** Marker so a reader (and a test) can recognise a substituted value unambiguously. */
export const AUDIT_MEDIA_MARKER = '__audit_media__';

export interface AuditMediaDescriptor {
  [AUDIT_MEDIA_MARKER]: 'data-url';
  mime: string;
  /** decoded image size in bytes */
  bytes: number;
  /** 64-bit identity digest over the base64 payload, hex, 16 chars */
  digest: string;
}

/** Any string at least this long is worth scanning; below it a data: URL cannot
 *  hold a meaningful image and the check would cost more than it saves. */
const MIN_SCAN_LENGTH = 64;
const DATA_URL_RE = /^data:([^;,]*)(;base64)?,/;

/**
 * 64-bit identity digest over the UTF-16 code units of `s`, hex-encoded (16
 * chars). Two independent 32-bit mixers in ONE pass: FNV-1a (xor-then-multiply)
 * and djb2-xor (multiply-then-xor). Different update orders and different
 * constants, so a collision would have to defeat both simultaneously.
 */
export function identityDigest64(s: string): string {
  let h1 = 0x811c9dc5 | 0;   // FNV-1a offset basis
  let h2 = 0x1505 | 0;       // djb2 offset basis
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2, 33) ^ c;
  }
  const a = (h1 >>> 0).toString(16).padStart(8, '0');
  const b = (h2 >>> 0).toString(16).padStart(8, '0');
  return a + b;
}

/** Decoded length of a base64 payload without allocating it. */
function decodedLength(payload: string): number {
  let len = 0, pad = 0;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    len++;
    if (payload[i] === '=') pad++;
  }
  return Math.max(0, Math.floor(len * 3 / 4) - pad);
}

/** True when the string is an inline base64 data: URL (the only blob shape the
 *  legacy product/repair/purchase-inbox columns ever produced). Deliberately a
 *  plain boolean, not a type predicate: narrowing `string` to `string` in the
 *  false branch would collapse it to `never` at every call site. */
export function isInlineDataUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length < MIN_SCAN_LENGTH) return false;
  const m = DATA_URL_RE.exec(v);
  return !!m && !!m[2];
}

/** Replace ONE inline data: URL with its descriptor. */
export function describeInlineDataUrl(src: string): AuditMediaDescriptor {
  const m = DATA_URL_RE.exec(src)!;
  const payload = src.slice(m[0].length);
  return {
    [AUDIT_MEDIA_MARKER]: 'data-url',
    mime: m[1] || 'application/octet-stream',
    bytes: decodedLength(payload),
    digest: identityDigest64(payload),
  };
}

/**
 * Recursively substitute every inline base64 data: URL inside an audit value.
 * Structure, key order and every non-image value are preserved byte for byte —
 * only the image payloads collapse. Returns the input unchanged when it holds no
 * inline image, so the overwhelmingly common case allocates nothing.
 *
 * Depth is bounded: audit values are shallow (a scalar, a field value, or one
 * product row), and an unbounded walk over a cyclic object would hang the writer.
 */
export function stripInlineMedia(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return isInlineDataUrl(value) ? describeInlineDataUrl(value) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const n = stripInlineMedia(v, depth + 1);
      if (n !== v) changed = true;
      return n;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = stripInlineMedia(v, depth + 1);
      if (n !== v) changed = true;
      out[k] = n;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * The audit serialiser. A JSON string that itself CONTAINS inline images (the
 * `products.images` column arrives as the raw JSON text `["data:image/…"]`, not
 * as an array) is re-serialised through the same substitution, so both shapes —
 * structured value and stringified column — end up blob-free.
 */
export function serializeAuditValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    if (isInlineDataUrl(v)) return JSON.stringify(describeInlineDataUrl(v));
    // A stringified JSON column that embeds data: URLs (e.g. products.images).
    if (v.length >= MIN_SCAN_LENGTH && v.includes('data:') && (v.startsWith('[') || v.startsWith('{'))) {
      try {
        const parsed = JSON.parse(v);
        const stripped = stripInlineMedia(parsed);
        if (stripped !== parsed) return JSON.stringify(stripped);
      } catch { /* not JSON → keep the original string */ }
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(stripInlineMedia(v)); } catch { return String(v); }
}
