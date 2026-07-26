// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C4A (+R1) — durable mobile-upload inbox + exactly-once core. INACTIVE.
//
// Nothing in the productive app imports this: no public mobile endpoint change,
// no client-protocol change, no UI wiring. It is the pure, framework-agnostic
// state machine + exactly-once DECISION layer a LATER slice would bind to a
// persistence surface and the real upload transport.
//
// ── R1 identity reality (proven against the real /sync/push DTO) ──────────────
// The wire DTO is `{ table_name, record_id, action, data }` (sync-service.ts).
//   • `record_id` is the PRODUCT ENTITY id (products.id) — it is REUSED verbatim
//     on a later legitimate `update`. It is NOT an upload/event id.
//   • There is NO event_id / op_id / payloadHash on the wire; the only per-change
//     counter (sync_changelog.id) is a LOCAL autoincrement, never transmitted.
//   • The mobile client (../mobile) is absent.
// Therefore a stable, per-upload EVENT identity does NOT exist in the current
// productive path. Exactly-once needs `uploadEventId`, which no real client
// supplies today. The core keeps the fields SEPARATE and generic, and the
// activation boundary is BLOCKED (MOBILE_INBOX_ACTIVATION below): no exactly-once
// is claimed for the productive mobile path, and NO uploadEventId is ever derived
// from a product- or image-hash (that would make two intentional duplicates, or a
// retry vs. a genuine edit, indistinguishable).
//
// Identity fields (kept strictly separate):
//   entityId       — the product entity id (may be reused across ops; NOT a key)
//   uploadEventId  — the stable per-upload event id (the ONLY retry key input)
//   payloadHash    — content hash over protocol + product meta + ordered image
//                    hashes (NO volatile field: receivedAt/server time excluded)
//   targetOp       — the intended operation (create_product)
// Deterministic retry key = tenant + branch + uploadEventId. Nothing volatile.
//
// Exactly-once rules:
//   • same uploadEventId + same payloadHash → idempotent (same job/result)
//   • same uploadEventId + different payloadHash → typed CONFLICT
//   • same entityId + NEW uploadEventId → a legitimate LATER op (separate record)
//   • different uploadEventIds + identical content → separate valid ops
//
// ── Durability claim (honestly scoped) ───────────────────────────────────────
// The node test backs the InboxStore with real sql.js and export→reopen. That
// proves ONLY that the state machine + persistence PORT are restart-capable. It
// does NOT prove productive acceptance, the productive app path, or updater-/kill-
// safety of the real inbox — those require the (blocked) activation + a real
// persistence binding + the real transport.
//
// ── second-writer reality + M6 activation dependency (recorded, not implemented)
// The existing LAN-sync upsert (sync-service.ts applyUpsert / /sync/push) is
// ALREADY a second writer the moment it is used — C4B does NOT introduce the
// second writer, it inherits an existing one. This inbox core is FULLY INACTIVE:
// it is not imported by any productive runtime path, it neither activates nor
// replaces the productive sync path, and the legacy sync path stays UNCHANGED and
// still not exactly-once-safe. Productive mobile exactly-once activation stays
// BLOCKED by (1) the missing uploadEventId/opId in the wire protocol and (2) the
// open M6 server-side CAS / stale-replay contract. Until M6 releases those rules,
// the LWW-by-arrival replay (see project_m6_stale_sync_replay) remains. No M6
// logic is implemented in this slice.
//
// Security: no free file paths, no path parts from filenames, raster-only, no
// SVG/active content, reuse the canonical 25-MiB / 8192-px / 24-MP image bounds
// plus a central per-batch cap, auth/scope fail-closed, unknown protocol version
// never silently interpreted, partial/corrupt uploads quarantined. NEVER logs
// image bytes/base64; NEVER stores base64 in SQLite (only hashes + staging refs).
// ════════════════════════════════════════════════════════════════════════════

import {
  sniffImageMime, readImageDimensions, checkPixelBudget,
  MAX_AI_INPUT_BYTES, MAX_AI_IMAGE_DIMENSION, MAX_AI_IMAGE_PIXELS,
} from './ai-image-source.ts';

// ── activation boundary ──────────────────────────────────────────────────────
/** The productive mobile inbox is BLOCKED from activation: the current
 *  /sync/push DTO carries no stable per-upload event id, and the mobile client is
 *  absent. Any activation slice (C4B) must first supply a REAL uploadEventId AND
 *  wait for the M6 server-side CAS / stale-replay release. This is a design fact,
 *  not a runtime toggle. */
export const MOBILE_INBOX_ACTIVATION = {
  activatable: false as const,
  blockedReasons: [
    'NO_STABLE_UPLOAD_EVENT_ID_IN_SYNC_PUSH_DTO',
    'MOBILE_CLIENT_ABSENT',
    'M6_SECOND_WRITER_CAS_NOT_RELEASED',
  ],
} as const;

// ── canonical bounds ─────────────────────────────────────────────────────────
export const MAX_UPLOAD_BATCH_IMAGES = 8;
export const MAX_UPLOAD_BATCH_BYTES = 40 * 1024 * 1024;
export const SUPPORTED_UPLOAD_PROTOCOLS = new Set<string>(['mobile-upload/1']);

// ── durable states ───────────────────────────────────────────────────────────
export type InboxState =
  | 'receiving' | 'accepted' | 'processing' | 'ready' | 'conflict' | 'quarantined';
export const TERMINAL_STATES: ReadonlySet<InboxState> = new Set(['ready', 'conflict', 'quarantined']);

export interface UploadIdentity {
  tenantId: string;
  branchId: string;
  /** The product entity id. May be reused across ops (create then later edit) —
   *  it is deliberately NOT part of the retry key. Null/absent for a fresh create
   *  where the entity id is only assigned by createProductWithMedia. */
  entityId: string | null;
  /** The stable per-upload event id — the ONLY caller-supplied retry-key input. */
  uploadEventId: string;
  clientProtocolVersion: string;
  payloadHash: string;
  /** Volatile: receipt timestamp. Excluded from BOTH the retry key and the hash. */
  receivedAt: string;
  targetOp: 'create_product';
}

/** Deterministic retry key: tenant + branch + uploadEventId. Never entityId,
 *  never a product/image hash, never a volatile timestamp. */
export function retryKey(id: { tenantId: string; branchId: string; uploadEventId: string }): string {
  return JSON.stringify([id.tenantId, id.branchId, id.uploadEventId]);
}

export interface InboxImage {
  index: number; mime: string; bytesHash: string;
  width: number; height: number; byteSize: number; stagingRef: string;
}
export interface UploadManifest {
  images: InboxImage[];
  product: Record<string, unknown>;
}
export interface InboxRecord {
  identity: UploadIdentity;
  manifest: UploadManifest;
  state: InboxState;
  productId?: string;
  conflictReason?: string;
  errorCode?: string;
}

// ── injected ports ───────────────────────────────────────────────────────────
export interface InboxStore {
  /** Durable read by the retry identity (tenant + uploadEventId). */
  get(tenantId: string, uploadEventId: string): InboxRecord | null;
  /** Durable, atomic, fsync-before-return write (the ACCEPTED guarantee relies
   *  on this — but see the honest durability scoping in the header). */
  put(record: InboxRecord): void;
}
export interface RawUploadImage { declaredMime: string; bytes: Uint8Array; }
export interface RawUploadSubmission {
  identity: {
    tenantId: string;
    branchId: string;
    entityId?: string | null;
    /** REQUIRED for activation. Absent/empty → typed activation block. */
    uploadEventId?: string;
    clientProtocolVersion: string;
    receivedAt?: string; // volatile — never feeds key or hash
    targetOp: 'create_product';
  };
  product: Record<string, unknown>;
  images: RawUploadImage[];
}
export interface InboxDeps {
  hashBytes: (b: Uint8Array) => string;
  hashString: (s: string) => string;
  stageBytes: (bytes: Uint8Array, mime: string) => string;
  now: () => string;
}

export type AcceptOutcome =
  | { ok: true; state: 'accepted' | 'ready'; record: InboxRecord }
  | { ok: false; state: 'conflict' | 'quarantined'; errorCode: string; record?: InboxRecord };

// ── validation ───────────────────────────────────────────────────────────────
export function validateInboxImage(
  raw: RawUploadImage,
  hashBytes: (b: Uint8Array) => string,
): { ok: true; mime: string; width: number; height: number; byteSize: number; hash: string } | { ok: false; errorCode: string } {
  if (!raw || !raw.bytes || raw.bytes.length === 0) return { ok: false, errorCode: 'MEDIA_INBOX_EMPTY_IMAGE' };
  if (raw.bytes.length > MAX_AI_INPUT_BYTES) return { ok: false, errorCode: 'MEDIA_INBOX_IMAGE_TOO_LARGE' };
  const sniff = sniffImageMime(raw.bytes);
  if (!sniff) return { ok: false, errorCode: 'MEDIA_INBOX_UNSUPPORTED_MIME' };
  const declared = (raw.declaredMime || '').toLowerCase() === 'image/jpg' ? 'image/jpeg' : (raw.declaredMime || '').toLowerCase();
  if (declared && declared !== sniff) return { ok: false, errorCode: 'MEDIA_INBOX_MIME_MISMATCH' };
  const dim = readImageDimensions(raw.bytes, sniff);
  if (!dim) return { ok: false, errorCode: 'MEDIA_INBOX_DIMENSIONS_UNKNOWN' };
  const budgetErr = checkPixelBudget(dim.width, dim.height, MAX_AI_IMAGE_DIMENSION, MAX_AI_IMAGE_PIXELS);
  if (budgetErr) return { ok: false, errorCode: budgetErr };
  return { ok: true, mime: sniff, width: dim.width, height: dim.height, byteSize: raw.bytes.length, hash: hashBytes(raw.bytes) };
}

export function validateUploadBatch(
  images: RawUploadImage[],
  hashBytes: (b: Uint8Array) => string,
): { ok: true; images: Array<{ index: number; mime: string; width: number; height: number; byteSize: number; hash: string }> } | { ok: false; errorCode: string } {
  if (!Array.isArray(images) || images.length === 0) return { ok: false, errorCode: 'MEDIA_INBOX_NO_IMAGES' };
  if (images.length > MAX_UPLOAD_BATCH_IMAGES) return { ok: false, errorCode: 'MEDIA_INBOX_TOO_MANY_IMAGES' };
  let total = 0;
  const out: Array<{ index: number; mime: string; width: number; height: number; byteSize: number; hash: string }> = [];
  for (let i = 0; i < images.length; i++) {
    const v = validateInboxImage(images[i], hashBytes);
    if (!v.ok) return { ok: false, errorCode: v.errorCode };
    total += v.byteSize;
    if (total > MAX_UPLOAD_BATCH_BYTES) return { ok: false, errorCode: 'MEDIA_INBOX_BATCH_TOO_LARGE' };
    out.push({ index: i, mime: v.mime, width: v.width, height: v.height, byteSize: v.byteSize, hash: v.hash });
  }
  return { ok: true, images: out };
}

/** Canonical payload over IDENTITY-DEFINING content ONLY: protocol, product meta
 *  (key-sorted), ordered image hashes. Deliberately excludes entityId, receivedAt
 *  and any server/volatile value so a retry reproduces the same hash. */
export function canonicalPayload(
  clientProtocolVersion: string,
  product: Record<string, unknown>,
  orderedImageHashes: string[],
): string {
  return JSON.stringify({ v: clientProtocolVersion, product: sortValue(product), images: orderedImageHashes });
}
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

// ── accept (validate → stage → persist → ACCEPTED), idempotent + conflict-typed ─
export function acceptUpload(store: InboxStore, sub: RawUploadSubmission, deps: InboxDeps): AcceptOutcome {
  const { tenantId, branchId, uploadEventId, clientProtocolVersion, targetOp } = sub.identity;
  if (!tenantId || !branchId) return { ok: false, state: 'quarantined', errorCode: 'MEDIA_INBOX_SCOPE_REQUIRED' };
  // R1: a REAL, caller-supplied uploadEventId is required. It is NEVER derived
  // from a product- or image-hash — absence is a typed ACTIVATION block, not a
  // silent fallback (which would confuse retries, duplicates and later edits).
  if (!uploadEventId) return { ok: false, state: 'quarantined', errorCode: 'MEDIA_INBOX_ACTIVATION_BLOCKED_NO_EVENT_ID' };
  if (targetOp !== 'create_product') return { ok: false, state: 'quarantined', errorCode: 'MEDIA_INBOX_UNKNOWN_TARGET_OP' };
  if (!SUPPORTED_UPLOAD_PROTOCOLS.has(clientProtocolVersion)) return { ok: false, state: 'quarantined', errorCode: 'MEDIA_INBOX_UNKNOWN_PROTOCOL' };

  const batch = validateUploadBatch(sub.images, deps.hashBytes);
  if (!batch.ok) return { ok: false, state: 'quarantined', errorCode: batch.errorCode };
  const payloadHash = deps.hashString(canonicalPayload(clientProtocolVersion, sub.product, batch.images.map((i) => i.hash)));

  // keyed by the retry identity (tenant + uploadEventId) — NOT entityId.
  const existing = store.get(tenantId, uploadEventId);
  if (existing) {
    if (existing.identity.payloadHash !== payloadHash) {
      return { ok: false, state: 'conflict', errorCode: 'MEDIA_INBOX_PAYLOAD_CONFLICT', record: existing };
    }
    if (existing.state === 'ready') return { ok: true, state: 'ready', record: existing };
    return { ok: true, state: 'accepted', record: existing };
  }

  const staged: InboxImage[] = [];
  for (let i = 0; i < sub.images.length; i++) {
    const meta = batch.images[i];
    const ref = deps.stageBytes(sub.images[i].bytes, meta.mime);
    staged.push({ index: meta.index, mime: meta.mime, bytesHash: meta.hash, width: meta.width, height: meta.height, byteSize: meta.byteSize, stagingRef: ref });
  }
  const record: InboxRecord = {
    identity: {
      tenantId, branchId,
      entityId: sub.identity.entityId ?? null,
      uploadEventId, clientProtocolVersion, payloadHash,
      receivedAt: sub.identity.receivedAt ?? deps.now(),
      targetOp: 'create_product',
    },
    manifest: { images: staged, product: sub.product },
    state: 'accepted',
  };
  store.put(record);
  return { ok: true, state: 'accepted', record };
}

// ── handoff (exactly once) to the existing durable product-create contract ─────
export interface ProductCreatePort {
  productExistsFor: (uploadEventKey: string, tenantId: string) => string | null;
  createProductWithMedia: (args: { uploadEventKey: string; identity: UploadIdentity; manifest: UploadManifest }) => { productId: string };
}

export function processInboxRecord(store: InboxStore, create: ProductCreatePort, rec: InboxRecord): InboxRecord {
  if (rec.state === 'ready') return rec;
  if (rec.state === 'conflict' || rec.state === 'quarantined') return rec;
  const uploadEventKey = rec.identity.uploadEventId;
  const already = create.productExistsFor(uploadEventKey, rec.identity.tenantId);
  if (already) {
    const done: InboxRecord = { ...rec, state: 'ready', productId: already };
    store.put(done);
    return done;
  }
  const processing: InboxRecord = { ...rec, state: 'processing' };
  store.put(processing);
  const res = create.createProductWithMedia({ uploadEventKey, identity: rec.identity, manifest: rec.manifest });
  const ready: InboxRecord = { ...processing, state: 'ready', productId: res.productId };
  store.put(ready);
  return ready;
}

export function recoverInbox(store: InboxStore, create: ProductCreatePort, records: InboxRecord[]): InboxRecord[] {
  const out: InboxRecord[] = [];
  for (const rec of records) {
    if (TERMINAL_STATES.has(rec.state)) { out.push(rec); continue; }
    if (rec.state === 'receiving') {
      const q: InboxRecord = { ...rec, state: 'quarantined', errorCode: 'MEDIA_INBOX_PARTIAL_ON_RECOVERY' };
      store.put(q);
      out.push(q);
      continue;
    }
    out.push(processInboxRecord(store, create, rec));
  }
  return out;
}
