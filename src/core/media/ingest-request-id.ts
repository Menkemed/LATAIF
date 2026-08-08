// ════════════════════════════════════════════════════════════════════════════
// MEDIA — the ingest request id contract (JS side of a HARD Rust rule).
//
// A media ingest request id is a filename component of the Rust ingest journal
// (`<scope>__<request_id>.json`), so `media::ingest` validates it strictly:
//
//     8..=80 characters, and ONLY [A-Za-z0-9_-]
//
// (`is_valid_request_id` in src-tauri/src/media/ingest.rs). Anything else is
// refused with `MEDIA_INGEST_INVALID_REQUEST` — BEFORE the request hash is even
// computed, so a bad id fails every prepare/commit/abort for that upload.
//
// The JS side used to compose ids like `create:<tenant>:<branch>:<productId>:
// <role>:<slot>` and `new:<slot>`. Both contain ':' and the second is also too
// short, so EVERY desktop-side image ingest (create-with-photo, and adding a
// photo in the ProductDetail editor) was rejected by the media core. The mobile
// pipeline was unaffected because its ids are derived in Rust. This module is
// the single place that turns a readable, composed id into one the media core
// accepts, so no call site can reintroduce the bug.
//
// Requirements the mapping must satisfy:
//   • DETERMINISTIC — the same logical parts always produce the same id. The
//     durable retry/recovery contract depends on a restarted attempt rebuilding
//     the identical id (same frozen batch, no duplicate media).
//   • TOTAL — any input (colons, spaces, unicode, very long scopes) maps into
//     the accepted charset and length, so the id can never be refused.
//   • DISTINGUISHING — ids that differ logically must not collide after
//     truncation; the readable head is therefore suffixed with a signature over
//     the FULL original string.
//
// The signature is a plain FNV-1a digest: this is an identity/namespacing helper,
// NOT a security boundary. The security-relevant value is `requestHash`, which
// Rust recomputes from the actual bytes and refuses on mismatch — a colliding id
// could at worst produce a fail-closed MEDIA_INGEST_REQUEST_CONFLICT, never a
// silent mix-up of image content.
// ════════════════════════════════════════════════════════════════════════════

/** Mirrors `is_valid_request_id` in src-tauri/src/media/ingest.rs. */
export const INGEST_REQUEST_ID_MIN = 8;
export const INGEST_REQUEST_ID_MAX = 80;

/** Exactly the Rust rule — used by the builders' tests and safe to assert with. */
export function isValidIngestRequestId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length >= INGEST_REQUEST_ID_MIN &&
    id.length <= INGEST_REQUEST_ID_MAX &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

/**
 * FNV-1a **64-bit**, as 16 lowercase hex chars. Deterministic and synchronous
 * (the id builders are synchronous; SubtleCrypto is async and unusable here).
 *
 * Width matters: at realistic scope lengths (tenant + branch + a uuid product id
 * + role) the readable head below is truncated, so the parts that actually
 * distinguish two ids — the slot, and for edits the batch uuid — survive ONLY in
 * this signature. 32 bits would leave distinctness resting on ~4.3e9 values; 64
 * bits puts a collision beyond any realistic id volume (and a collision is
 * fail-closed: the Rust journal binds an id to its content hash, so a clash
 * surfaces as MEDIA_INGEST_REQUEST_CONFLICT, never as mixed-up image content).
 */
function fnv1a64(s: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Map any composed, readable id onto the media core's accepted id space.
 *
 * The result is `<sanitised, truncated head>-<8 hex signature of the full raw>`:
 * still greppable in the journal/DB, always within the charset, always
 * 8..=80 chars, and stable for a given input.
 */
export function toIngestRequestId(raw: string): string {
  const source = typeof raw === 'string' && raw.length > 0 ? raw : 'ingest';
  const sig = fnv1a64(source);
  const head = source.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, INGEST_REQUEST_ID_MAX - sig.length - 1);
  return `${head}-${sig}`;
}
