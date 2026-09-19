// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B1 — TypeScript gateway over the 5 Rust `#[tauri::command]`
// media handlers. INACTIVE outside its own test suite; no React caller yet.
//
// The production adapter binds to `@tauri-apps/api/core::invoke` behind a lazy
// require so the module can be imported in Node-side tests without pulling
// Tauri into the graph. Tests pass in a deterministic `FakeMediaGateway`.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Rendition descriptor as returned by the Rust ingest core. Never carries
 * image bytes or an OS path — only content-addressed metadata.
 */
export interface RustStoredDescriptor {
  hash: string;          // 64-hex, lower-case
  extension: string;     // "jpg"
  content_kind: string;  // "raster_image"
  mime_type: string;     // "image/jpeg"
  byte_size: number;     // ≤100 000 for main, ≤20 000 for thumbnail
  width: number;
  height: number;
}

export interface PrepareInput {
  tenantScope: string;
  ingestRequestId: string;
  requestHash: string;
  imageBytes: Uint8Array;
  originalName?: string;
}

export interface PrepareResult {
  ingest_request_id: string;
  request_hash: string;
  state: string; // "prepared" | "publishing" | "published"
  main_descriptor: RustStoredDescriptor;
  thumbnail_descriptor: RustStoredDescriptor;
}

export interface CommitInput {
  tenantScope: string;
  ingestRequestId: string;
  requestHash: string;
}

export interface CommitResult {
  state: string; // "published"
  main_descriptor: RustStoredDescriptor;
  thumbnail_descriptor: RustStoredDescriptor;
  main_storage_key: string;
  thumbnail_storage_key: string;
}

export interface AbortInput {
  tenantScope: string;
  ingestRequestId: string;
}

export interface AbortResult {
  ingest_request_id: string;
  state: string;
}

export interface ReadVerifiedInput {
  tenantScope: string;
  hash: string;
  extension: string;
}

/**
 * Bytes + metadata as returned by the Rust `read_verified_media` command. The
 * bytes come back as `number[]` over IPC and are converted to a `Uint8Array`
 * by the production adapter; the fake gateway hands them out directly.
 */
export interface MediaBytes {
  bytes: Uint8Array;
  hash: string;
  byte_size: number;
  mime_type: string;
  extension: string;
}

export interface RecoveryOutcome {
  tenant_scope: string;
  ingest_request_id: string;
  from_state: string;
  to_state: string;
  action: string;
}

/**
 * The narrow surface the DB coordinator sees. Real production wraps the Tauri
 * `invoke`; tests substitute a `FakeMediaGateway` that behaves identically.
 */
export interface MediaCommandGateway {
  prepareStockImage(input: PrepareInput): Promise<PrepareResult>;
  commitStockImage(input: CommitInput): Promise<CommitResult>;
  abortStockImage(input: AbortInput): Promise<AbortResult>;
  readVerifiedMedia(input: ReadVerifiedInput): Promise<MediaBytes>;
  recoverMediaIngests(): Promise<RecoveryOutcome[]>;
}

/**
 * Production adapter — thin passthrough to `@tauri-apps/api/core::invoke`.
 * The IPC transport moves `Uint8Array` as a JSON `number[]`; on the read
 * path we normalise it back to a `Uint8Array` so callers only ever see the
 * typed buffer.
 */
export class TauriMediaGateway implements MediaCommandGateway {
  private readonly invoker: <T = unknown>(cmd: string, args?: unknown) => Promise<T>;

  constructor(invoker?: <T = unknown>(cmd: string, args?: unknown) => Promise<T>) {
    if (invoker) {
      this.invoker = invoker;
    } else {
      // Lazy-load: the Node-side tests import this module without a Tauri
      // context; a lookup only happens when a production call is actually
      // made, so we do not blow up at import time.
      this.invoker = async <T>(cmd: string, args?: unknown): Promise<T> => {
        const mod = await import('@tauri-apps/api/core');
        return mod.invoke<T>(cmd, args as Record<string, unknown> | undefined);
      };
    }
  }

  async prepareStockImage(input: PrepareInput): Promise<PrepareResult> {
    return this.invoker<PrepareResult>('media_prepare_stock_image', {
      tenantScope: input.tenantScope,
      ingestRequestId: input.ingestRequestId,
      requestHash: input.requestHash,
      // Tauri serialises `Uint8Array` as a `number[]`; the Rust side reads it
      // as `Vec<u8>`. No base64 anywhere on the wire.
      imageBytes: Array.from(input.imageBytes),
      originalName: input.originalName,
    });
  }

  async commitStockImage(input: CommitInput): Promise<CommitResult> {
    return this.invoker<CommitResult>('media_commit_stock_image', {
      tenantScope: input.tenantScope,
      ingestRequestId: input.ingestRequestId,
      requestHash: input.requestHash,
    });
  }

  async abortStockImage(input: AbortInput): Promise<AbortResult> {
    return this.invoker<AbortResult>('media_abort_stock_image', {
      tenantScope: input.tenantScope,
      ingestRequestId: input.ingestRequestId,
    });
  }

  async readVerifiedMedia(input: ReadVerifiedInput): Promise<MediaBytes> {
    const raw = await this.invoker<
      Omit<MediaBytes, 'bytes'> & { bytes: number[] | Uint8Array }
    >('media_read_verified', {
      tenantScope: input.tenantScope,
      hash: input.hash,
      extension: input.extension,
    });
    const bytes =
      raw.bytes instanceof Uint8Array ? raw.bytes : new Uint8Array(raw.bytes);
    return { ...raw, bytes };
  }

  async recoverMediaIngests(): Promise<RecoveryOutcome[]> {
    return this.invoker<RecoveryOutcome[]>('media_recover_ingests');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-S1 — the binary path for byte-exact originals (documents).
//
// Tauri 2 sends a `Uint8Array`/`ArrayBuffer` argument as a RAW request body (metadata in headers)
// and returns a `tauri::ipc::Response` as an `ArrayBuffer`. That is the transport for originals:
// the bytes never become a JSON `number[]` and never a Base64 string. The product-image methods
// above stay exactly as they were (their inputs are small and normalised). Nothing calls
// `publishOriginal` yet — documents arrive in S5.
// ════════════════════════════════════════════════════════════════════════════

/** Same ceiling as `raw_transport::max_raw_transport_bytes` (the largest original kind, 25 MiB). */
export const ORIGINAL_MAX_BYTES = 25 * 1024 * 1024;
/** The original kinds the store accepts — mirror of `STORED_KINDS` where `original: true`. */
export const ORIGINAL_EXTENSIONS = ['pdf'] as const;
export type OriginalExtension = typeof ORIGINAL_EXTENSIONS[number];

export interface OriginalDescriptor {
  storage_key: string;
  hash: string;
  byte_size: number;
  mime_type: string;
  extension: string;
  content_kind: string;
  reused: boolean;
}

export class OriginalTransportError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'OriginalTransportError'; }
}

type RawInvoker = <T = unknown>(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<T>;

export class OriginalMediaTransport {
  private readonly invoker: RawInvoker;
  constructor(invoker?: RawInvoker) {
    this.invoker = invoker ?? (async <T>(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> => {
      const mod = await import('@tauri-apps/api/core');
      return mod.invoke<T>(cmd, args as never, options);
    });
  }

  /** Store a document byte-exactly. Refused here already when it cannot pass the store (kind, size). */
  async publishOriginal(input: { tenantScope: string; extension: OriginalExtension; bytes: Uint8Array; sha256?: string }): Promise<OriginalDescriptor> {
    if (!(ORIGINAL_EXTENSIONS as readonly string[]).includes(input.extension)) throw new OriginalTransportError('MEDIA_ORIGINAL_KIND_NOT_ALLOWED');
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new OriginalTransportError('MEDIA_ORIGINAL_EMPTY');
    if (input.bytes.byteLength > ORIGINAL_MAX_BYTES) throw new OriginalTransportError('MEDIA_ORIGINAL_TOO_LARGE');
    const headers: Record<string, string> = {
      'x-lataif-tenant-scope': input.tenantScope,
      'x-lataif-extension': input.extension,
    };
    if (input.sha256) headers['x-lataif-sha256'] = input.sha256;
    // The typed array itself is the argument — Tauri carries it as a raw body.
    return this.invoker<OriginalDescriptor>('media_publish_original', input.bytes, { headers });
  }

  /** Read verified bytes as a raw ArrayBuffer (any stored kind). */
  async readVerifiedRaw(input: ReadVerifiedInput): Promise<Uint8Array> {
    const raw = await this.invoker<ArrayBuffer | Uint8Array>('media_read_verified_raw', {
      tenantScope: input.tenantScope, hash: input.hash, extension: input.extension,
    });
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    // A JSON array here would mean the raw path silently fell back — refuse rather than accept it.
    throw new OriginalTransportError('MEDIA_RAW_RESPONSE_EXPECTED');
  }
}
