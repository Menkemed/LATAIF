// MOBILE-04B2A2 — internal Rust↔JS mobile-upload drain worker.
//
// Drains the durable server-side Rust inbox (via INTERNAL Tauri commands — no HTTP route, no
// `mobile_page.rs`) into the existing product/media create pipeline, EXACTLY ONCE and restart-safe:
//
//   claim (Rust) → re-verify handed-off manifest → resolve resume/conflict against the durable
//   sql.js receipt + product → createProductWithMedia(entityId, receiptIntent) [product + receipt
//   in ONE durable checkpoint] → verify the product/gallery is real → mark the SAME Rust job `ready`.
//
// The Rust side owns the lease/claim token; the sql.js `mobile_upload_receipts` row is the durable
// cross-DB resume anchor. Neither Rust writes the sql.js DB nor does JS write the server DB except
// through these two contracts. `collection` only. No second product-write path; no base64 in
// products.images. The saga is fully dependency-injected so it is testable against real temp DBs
// with a fake bridge.

import type { ProductCreateResult } from './product-media-create';
import type { MobileUploadReceiptIntent } from '../../stores/productStore';
import type { PrepareResult } from './gateway';
import { runtimeScopeAvailable, runtimeBindingRevisionOf, type RuntimeScopeEvidence } from './runtime-scope-evidence.ts';
import { buildSkuSeed, skuIsEmpty } from '../products/sku-allocation.ts';
import { parseMobileGalleryPlan, ERR_GALLERY_PLAN_INVALID, type MobileGalleryPlan } from './mobile-gallery-edit.ts';
import {
  parseMobileProductPatch, resolveMobileProductPatch, patchTouchesPrices,
  ERR_PRICE_NOT_ELIGIBLE,
  type MobileProductPatch, type CurrentProductState,
} from './mobile-product-patch.ts';
import type { MobileFieldSchema } from '../mobile/mobile-field-schema.ts';

/** One image prepared out-of-band (Rust staged + rendered it) for the durable create batch — an
 *  opaque descriptor, no bytes. */
export interface PreparedMediaItem {
  slot: number;
  isPrimary: boolean;
  ingestRequestId: string;
  prepared: PrepareResult;
}

export const MOBILE_DRAIN_LEASE_SECONDS = 120;

// ── the Rust bridge (INTERNAL Tauri commands) ────────────────────────────────
export interface ClaimedImage {
  slot: number;
  primary: boolean;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
  contentHash: string;
  storageKey: string; // opaque content-addressed token, NOT a filesystem path — never carries bytes
}
export interface ClaimGrant {
  tenantId: string;
  branchId: string;
  authenticatedUserId: string;
  uploadEventId: string;
  entityId: string;
  payloadHash: string;
  mode: string;
  metadataJson: string;
  claimToken: string;
  claimantInstanceId: string;
  leaseUntil: string;
  images: ClaimedImage[];
}
export type ReadyResult = 'marked_ready' | 'already_ready' | 'rejected';

/** MOBILE-04B2A7-I1 — the caller's expected runtime scope, forwarded to EVERY registered mutation
 *  command so the server-side revision fence can accept or reject it. Sourced ONLY from the freshly
 *  validated worker scope (never a default/cache). The three keys are exactly the command argument
 *  names, so the Tauri bridge spreads it straight into the invoke payload. */
export interface DrainScope {
  expectedBindingRevision: number;
  expectedTenantId: string;
  expectedBranchId: string;
}

export interface MobileUploadBridge {
  claim(claimantInstanceId: string, leaseSeconds: number, scope: DrainScope): Promise<ClaimGrant | null>;
  /** Prepare ONE claimed image via the Rust media core (bytes stay in Rust). Returns an opaque
   *  descriptor whose `ingest_request_id` is the SERVER-derived, provenance-bound prepareRequestId
   *  (JS does not supply it). Rejects for a stale/foreign token, wrong origin user, a non-processing
   *  job, or a bad slot. NO image bytes cross IPC. */
  prepareImage(originAuthenticatedUserId: string, uploadEventId: string, claimToken: string, slot: number, tenantScope: string, scope: DrainScope): Promise<PrepareResult>;
  renew(originAuthenticatedUserId: string, uploadEventId: string, claimToken: string, claimantInstanceId: string, leaseSeconds: number, scope: DrainScope): Promise<boolean>;
  release(originAuthenticatedUserId: string, uploadEventId: string, claimToken: string, scope: DrainScope): Promise<boolean>;
  markQuarantined(originAuthenticatedUserId: string, uploadEventId: string, claimToken: string, code: string, scope: DrainScope): Promise<boolean>;
  markReady(originAuthenticatedUserId: string, uploadEventId: string, claimToken: string, entityId: string, payloadHash: string, productId: string, scope: DrainScope): Promise<ReadyResult>;
}

/** Production bridge over the internal Tauri commands. Injectable invoker for Node tests. Every call
 *  spreads the caller-supplied `scope` (expected binding revision + tenant + branch) into the invoke
 *  payload, so each registered command receives its scope expectation for the server-side fence. */
export function createTauriMobileUploadBridge(
  invoker?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
): MobileUploadBridge {
  const invoke = invoker ?? (async <T>(cmd: string, args?: Record<string, unknown>) => {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(cmd, args as Record<string, unknown> | undefined);
  });
  return {
    claim: (claimantInstanceId, leaseSeconds, scope) =>
      invoke<ClaimGrant | null>('mobile_upload_claim', { claimantInstanceId, leaseSeconds, ...scope }),
    prepareImage: (originAuthenticatedUserId, uploadEventId, claimToken, slot, tenantScope, scope) =>
      invoke<PrepareResult>('mobile_upload_prepare_image', { originAuthenticatedUserId, uploadEventId, claimToken, slot, tenantScope, ...scope }),
    renew: (originAuthenticatedUserId, uploadEventId, claimToken, claimantInstanceId, leaseSeconds, scope) =>
      invoke<boolean>('mobile_upload_renew', { originAuthenticatedUserId, uploadEventId, claimToken, claimantInstanceId, leaseSeconds, ...scope }),
    release: (originAuthenticatedUserId, uploadEventId, claimToken, scope) =>
      invoke<boolean>('mobile_upload_release', { originAuthenticatedUserId, uploadEventId, claimToken, ...scope }),
    markQuarantined: (originAuthenticatedUserId, uploadEventId, claimToken, code, scope) =>
      invoke<boolean>('mobile_upload_mark_quarantined', { originAuthenticatedUserId, uploadEventId, claimToken, code, ...scope }),
    markReady: (originAuthenticatedUserId, uploadEventId, claimToken, entityId, payloadHash, productId, scope) =>
      invoke<ReadyResult>('mobile_upload_mark_ready', { originAuthenticatedUserId, uploadEventId, claimToken, entityId, payloadHash, productId, ...scope }),
  };
}

// ── saga dependencies (all injectable) ───────────────────────────────────────
export interface DurableReceipt {
  payloadHash: string;
  entityId: string;
  productId: string;
  createBatchId: string;
  canonicalProductMetadataHash: string;
  preparedManifestHash: string;
}
/** One durable gallery slot (media_links) — the third SSOT's explicit slot/primary proof. */
export interface GallerySlot { sortOrder: number; isPrimary: boolean }
/** How the resolved product verifies after create: fully ready, still finishing, or broken. */
export type ReadyVerdict = 'ready' | 'pending' | 'broken';

export interface MobileDrainDeps {
  bridge: MobileUploadBridge;
  claimantInstanceId: string;
  /** MOBILE-04B2A3-R1 §1/§2 — read the CURRENT Rust scope evidence FRESH from the server (the
   *  registered read command derives the install id server-side). Called at every guard boundary —
   *  worker creation, each claim cycle, before prepare, before the checkpoint, and immediately before
   *  ready/quarantine — so a once-read revision NEVER outlives a later rebind. The wiring may dedup a
   *  concurrent read but must never return a stale revision as truth. Absent → BLOCKED (fail closed). */
  readScopeEvidence?: () => Promise<RuntimeScopeEvidence | null>;
  /** The current authenticated desktop scope, or null when not authenticated. */
  currentScope: () => { tenantId: string; branchId: string } | null;
  /** SKU-ALLOC §A3 — claim the next SKU for a generated seed. Authoritative and side-effecting:
   *  the number is taken from the durable per-stem counter, so a second caller cannot be handed the
   *  same one and a later deletion cannot release it. Optional: without it an upload without a SKU
   *  stays without one, which is the behaviour before this existed. */
  allocateSku?: (seed: string) => string;
  /** The durable sql.js source-binding for this upload. Keyed by the FULL identity incl. user. */
  readReceipt: (tenantId: string, branchId: string, authenticatedUserId: string, uploadEventId: string) => DurableReceipt | null;
  productExists: (productId: string) => boolean;
  /** The stored product's canonical metadata hash, for the pre-ready projection check. */
  readProductMetadataHash: (productId: string) => Promise<string | null>;
  /** The DURABLE create batch (media_ingest_jobs) bound to this product, for the pre-ready
   *  batch-manifest check — proves the exact bound batch is present, not just a gallery. */
  readBoundBatch: (entityId: string) => Promise<BoundBatchJob[]>;
  /** The ACTIVE durable gallery (media_links) — the third SSOT with EXPLICIT slot/primary. */
  readGalleryManifest: (entityId: string) => Promise<GallerySlot[]>;
  /** Durable side-effect counts for the product (exactly one changelog + one audit expected). */
  readSideEffectCounts: (entityId: string) => Promise<{ changelog: number; audit: number }>;
  /** The deterministic create-batch id bound by the receipt (SSOT cross-check). */
  deriveCreateBatchId: (entityId: string) => string;
  /** Prepare every image out-of-band via the Rust media core (bytes stay in Rust); returns the
   *  ordered opaque descriptors. Throws MaterializeError('broken') on hash/slot/scope mismatch or
   *  ('unavailable') on a stale token / transient error. */
  preparePreparedMedia: (grant: ClaimGrant, scope: DrainScope) => Promise<PreparedMediaItem[]>;
  /** createProductWithMedia — pins entityId, takes the already-prepared media descriptors (no
   *  bytes/data-URLs), and writes the receipt atomically with the product. */
  createProduct: (grant: ClaimGrant, prepared: PreparedMediaItem[], receiptIntent: MobileUploadReceiptIntent) => Promise<ProductCreateResult>;
  /** Real post-create verification: product in scope, gallery == ordered manifest, primary slot 0,
   *  active media hash-verified, products.images has no new base64, sync/audit exactly once. */
  verifyReady: (grant: ClaimGrant) => Promise<ReadyVerdict>;
  /** MOBILE-EDIT-S2 — den kanonischen durablen Textedit anwenden (`editProductTextDurably`). Er
   *  fasst `media_links` per Vertrag nicht an und setzt nur die uebergebenen Felder. Fehlt die
   *  Abhaengigkeit, wird ein Edit-Job NICHT verarbeitet und auch nicht terminal markiert — er
   *  bleibt fuer einen spaeteren, vollstaendig verdrahteten Lauf liegen. */
  applyTextEdit?: (entityId: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; errorCode?: string }>;
  /** MOBILE-EDIT-S3 — den geprueften Galerie-Plan durabel anwenden: Baseline unter der Sperre lesen,
   *  `buildMobileGalleryEnvelope` bauen und ueber `applyEditDurably` in EINER Transaktion committen.
   *  Fehlt die Abhaengigkeit, wird ein Galerie-Job NICHT verarbeitet und auch nicht terminal
   *  markiert — er bleibt fuer einen spaeteren, vollstaendig verdrahteten Lauf liegen. */
  applyGalleryEdit?: (grant: ClaimGrant, prepared: PreparedMediaItem[], plan: MobileGalleryPlan) => Promise<{ ok: boolean; errorCode?: string }>;
  /** v0.8.48 — der aktuelle Stand des Artikels, gelesen unter der Sperre: Kategorie, gespeicherte
   *  Attribute und Lieferumfang. Grundlage fuer den Merge und fuer die Schema-Pruefung. */
  readProductState?: (productId: string) => CurrentProductState | null;
  /** Die Kategorie-Definition, die auch das Anlegen benutzt. Eine zweite Liste fuers Handy gibt es nicht. */
  fieldSchema?: () => MobileFieldSchema;
  /** Darf DIESER Artikel seine Preise noch aendern? Wahr nur, wenn es keinerlei Beschaffungs- oder
   *  Kostenbeleg gibt (keine Einkaufszeile, kein Lot, Eigenbestand). Fehlt die Abhaengigkeit, wird
   *  jede Preisaenderung abgelehnt — fail closed. */
  priceEditAllowed?: (productId: string) => boolean;
}

export type DrainCode =
  | 'ready' | 'resumed' | 'foreign_scope' | 'manifest_invalid'
  | 'operation_conflict' | 'target_conflict' | 'deferred' | 'ready_rejected' | 'idle'
  | 'scope_blocked';
export interface DrainOutcome { code: DrainCode; detail?: string }

/** MOBILE-04B2A2-R5 §2 — true when NO canonical runtime scope evidence is available, i.e. the drain
 *  must NOT run. Fail closed: a missing predicate is treated as blocked. */
/** MOBILE-04B2A3-R1 — one FRESH read of the Rust scope evidence, reduced to (available, revision).
 *  `available` requires a configured binding that exactly matches the active auth/DB scope; `revision`
 *  is the current binding revision (0 when unbound). Never uses a hardcoded scope fallback. */
async function freshScope(deps: MobileDrainDeps): Promise<{ available: boolean; revision: number; scope: DrainScope | null }> {
  const cur = deps.currentScope();
  const ev = deps.readScopeEvidence ? await deps.readScopeEvidence() : null;
  const available = runtimeScopeAvailable(ev, cur);
  const revision = runtimeBindingRevisionOf(ev);
  // The scope triple is built ONLY from validated evidence + the active auth scope — never a default or
  // cached value. `available` already requires `cur` to be present and to match the evidence exactly.
  return {
    available,
    revision,
    scope: available && cur ? { expectedBindingRevision: revision, expectedTenantId: cur.tenantId, expectedBranchId: cur.branchId } : null,
  };
}

/** A running claim is fenced when the scope is no longer available OR the binding revision moved away
 *  from the one the claim started under — either way it must NOT write ready/quarantine. */
async function claimFenced(deps: MobileDrainDeps, entryRevision: number): Promise<boolean> {
  const s = await freshScope(deps);
  return !s.available || s.revision !== entryRevision;
}

// error codes stamped onto quarantined Rust jobs
const ERR_MANIFEST = 'MOBILE_UPLOAD_HANDOFF_MANIFEST_INVALID';
const ERR_OP_CONFLICT = 'MOBILE_UPLOAD_OPERATION_CONFLICT';
const ERR_TARGET_CONFLICT = 'MOBILE_UPLOAD_TARGET_CONFLICT';
const ERR_RECEIPT_INCONSISTENT = 'MOBILE_UPLOAD_RECEIPT_INCONSISTENT';
const ERR_BROKEN = 'MOBILE_UPLOAD_MEDIA_BROKEN';
const ERR_METADATA_MISMATCH = 'MOBILE_UPLOAD_METADATA_MISMATCH';
const ERR_BATCH_MISMATCH = 'MOBILE_UPLOAD_BATCH_MISMATCH';
// MOBILE-EDIT-S2 — ein Edit-Job, der mehr will als Text, wird quarantaeniert statt halb ausgefuehrt.
const ERR_EDIT_GALLERY_UNSUPPORTED = 'MOBILE_EDIT_GALLERY_NOT_SUPPORTED';
const ERR_EDIT_PATCH_INVALID = 'MOBILE_EDIT_PATCH_INVALID';
// MOBILE-EDIT-S3 — eine Job-Art, die dieser Stand nicht kennt, wird abgelehnt statt geraten.
const ERR_UNKNOWN_JOB_KIND = 'MOBILE_UNKNOWN_JOB_KIND';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic, key-sorted JSON. */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
export interface ProductProjectionFields { brand?: unknown; name?: unknown; categoryId?: unknown; sku?: unknown; attributes?: unknown }
/** Canonical projection of the FULL set of product fields written from the mobile metadata
 *  (brand, name, categoryId, sku, attributes) — not just a chosen few. Both the receipt binding
 *  (from the frozen metadata) and the pre-ready check (from the stored product) hash this identical
 *  projection, so any drift in ANY bound field is caught. */
export function canonicalProductProjection(f: ProductProjectionFields): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const attrs = (f.attributes && typeof f.attributes === 'object') ? f.attributes : {};
  return canonicalJson({ brand: s(f.brand), categoryId: s(f.categoryId), name: s(f.name), sku: s(f.sku), attributes: attrs });
}
export function canonicalProductMetadataHash(f: ProductProjectionFields): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalProductProjection(f)));
}
export function projectionFieldsFromMetadata(metadataJson: string): ProductProjectionFields {
  let m: Record<string, unknown> = {};
  try { m = JSON.parse(metadataJson) as Record<string, unknown>; } catch { m = {}; }
  return { brand: m.brand, name: m.name, categoryId: m.categoryId, sku: m.sku, attributes: m.attributes };
}

/**
 * SKU-ALLOC — return the grant with a SKU filled in, or unchanged.
 *
 * Unchanged when: the wiring supplies no allocator (then this stays exactly the pre-allocation
 * behaviour), the metadata is unparseable, the operator already typed a SKU on the phone, or the
 * allocator produced nothing. Never overwrites a SKU that came from the upload.
 *
 * The seed always carries an explicit `-001`, so a model number that ends the brand/category code
 * can never be mistaken for the sequence.
 */
export function withAllocatedSku(grant: ClaimGrant, deps: MobileDrainDeps): ClaimGrant {
  if (!deps.allocateSku) return grant;
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(grant.metadataJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return grant;
    m = parsed as Record<string, unknown>;
  } catch {
    return grant;
  }
  if (!skuIsEmpty(m.sku)) return grant;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const sku = deps.allocateSku(buildSkuSeed(str(m.brand), str(m.categoryId)));
  if (!sku) return grant;
  return { ...grant, metadataJson: JSON.stringify({ ...m, sku }) };
}

/** A prepared image's identity — the SERVER-derived prepareRequestId (which itself binds
 *  scope+originUser+uploadEventId+slot+contentHash) plus the request hash of its bytes. */
export interface PreparedIdentity { prepareRequestId: string; requestHash: string }
/** One durable batch job (media_ingest_jobs) row of the bound create batch. */
export interface BoundBatchJob { ingestRequestId: string; requestHash: string }

/** The receipt's frozen binding over the FULL prepared manifest: the ordered grant descriptors
 *  (slot/primary/contentHash/mime/dims/size) AND the SORTED set of prepared identities. Each
 *  prepareRequestId already encodes its slot+contentHash, so the set binds provenance without
 *  depending on post-finalize job columns; gallery order is verified separately by the resolver. */
export function preparedManifestHash(grantImages: ClaimedImage[], prepared: PreparedIdentity[]): Promise<string> {
  const grant = [...grantImages].sort((a, b) => a.slot - b.slot).map((im) => ({
    slot: im.slot, primary: im.primary, contentHash: im.contentHash, mime: im.mime, width: im.width, height: im.height, byteSize: im.byteSize,
  }));
  const ids = [...prepared].sort((a, b) => (a.prepareRequestId < b.prepareRequestId ? -1 : a.prepareRequestId > b.prepareRequestId ? 1 : 0))
    .map((p) => ({ prepareRequestId: p.prepareRequestId, requestHash: p.requestHash }));
  return sha256Hex(new TextEncoder().encode(canonicalJson({ grant, prepared: ids })));
}
export function identitiesFromPrepared(prepared: PreparedMediaItem[]): PreparedIdentity[] {
  return prepared.map((p) => ({ prepareRequestId: p.ingestRequestId, requestHash: p.prepared.request_hash }));
}
export function identitiesFromBatch(batch: BoundBatchJob[]): PreparedIdentity[] {
  return batch.map((b) => ({ prepareRequestId: b.ingestRequestId, requestHash: b.requestHash }));
}
/** The active gallery must have EXACTLY the grant's slots (contiguous 0..N-1), a single primary at
 *  slot 0, and each slot's primary flag equal to the grant manifest. */
export function galleryMatchesGrant(gallery: GallerySlot[], grantImages: ClaimedImage[]): boolean {
  if (gallery.length !== grantImages.length) return false;
  const g = [...gallery].sort((a, b) => a.sortOrder - b.sortOrder);
  const primaries = g.filter((s) => s.isPrimary).map((s) => s.sortOrder);
  if (primaries.length !== 1 || primaries[0] !== 0) return false;
  for (let i = 0; i < g.length; i++) {
    if (g[i].sortOrder !== i) return false;                       // contiguous 0..N-1
    if (g[i].sortOrder !== grantImages[i].slot) return false;     // == grant slot
    if (g[i].isPrimary !== grantImages[i].primary) return false;  // == grant primary
  }
  return true;
}

/** Structural manifest check on the DESCRIPTORS (no bytes present): contiguous slots 0..N-1 and
 *  exactly one primary at slot 0. Byte/hash verification happens per image during materialisation. */
export function verifyGrantManifest(grant: ClaimGrant): { ok: boolean; code?: string } {
  const imgs = grant.images;
  if (!Array.isArray(imgs) || imgs.length === 0) return { ok: false, code: ERR_MANIFEST };
  const sorted = [...imgs].sort((a, b) => a.slot - b.slot);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].slot !== i) return { ok: false, code: ERR_MANIFEST }; // gap / duplicate
    if (!sorted[i].mime || sorted[i].byteSize <= 0 || sorted[i].contentHash.length !== 64) return { ok: false, code: ERR_MANIFEST };
  }
  const primaries = sorted.filter((x) => x.primary).map((x) => x.slot);
  if (primaries.length !== 1 || primaries[0] !== 0) return { ok: false, code: ERR_MANIFEST };
  return { ok: true };
}

/** A materialisation failure that tells the saga how to react. */
export class MaterializeError extends Error {
  readonly kind: 'broken' | 'unavailable';
  constructor(kind: 'broken' | 'unavailable') { super(kind); this.kind = kind; }
}

/** Process exactly one claimed job through the create/verify/ready saga. Idempotent and
 *  crash-safe: the durable receipt + product make a resume converge to the SAME product. */
export async function processMobileUploadClaim(grant: ClaimGrant, deps: MobileDrainDeps): Promise<DrainOutcome> {
  const u = grant.authenticatedUserId; // ORIGIN user — every per-job call is keyed by it + the token
  // MOBILE-04B2A3-R1 — read FRESH evidence at entry and capture the binding revision this claim runs
  // under. If the Rust binding rebinds (or is revoked) across any async step, the claim must NOT mark
  // ready/quarantine — it releases. A once-read revision never becomes stale truth.
  const entry = await freshScope(deps);
  // MOBILE-04B2A7-I1 — fail closed: without a validated worker scope there is NO invoke at all.
  if (!entry.available || !entry.scope) { return { code: 'scope_blocked' }; }
  const entryRevision = entry.revision;
  // The validated scope this claim runs under — forwarded to every per-job command so the server fence
  // accepts it while the binding is unchanged and rejects it the moment an owner rebinds.
  const sc = entry.scope;
  // Scope: only ever process a job that belongs to the current authenticated desktop scope.
  const scope = deps.currentScope();
  if (!scope || scope.tenantId !== grant.tenantId || scope.branchId !== grant.branchId) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc); // foreign — hand it straight back
    return { code: 'foreign_scope' };
  }
  // MOBILE-EDIT-S2 — die Verzweigung sitzt VOR der Manifest-Pruefung: die prueft die Bildliste
  // eines Creates (Slots 0..N-1, genau ein primary) und muss bei einem Text-Edit mit null Bildern
  // zwangslaeufig scheitern. Die passende Regel fuer einen Edit — die Bildliste MUSS leer sein —
  // steht in `processEditClaim` und ist dort genauso fail-closed.
  if (isMobileTextEditJob(grant.metadataJson)) return processEditClaim(grant, deps, sc, entryRevision);
  if (isMobileGalleryEditJob(grant.metadataJson)) return processGalleryEditClaim(grant, deps, sc, entryRevision);
  // Ein `kind`, das dieser Desktop nicht kennt, wird NICHT als Create behandelt. Der Server weist so
  // etwas schon beim Annehmen ab; taucht es hier trotzdem auf (aelterer Job, anderer Stand), ist die
  // Absicht unbekannt — und ein unbekannter Auftrag wird quarantaeniert, nicht geraten.
  if (mobileJobKindMarker(grant.metadataJson) === 'unknown') {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_UNKNOWN_JOB_KIND, sc);
    return { code: 'manifest_invalid', detail: ERR_UNKNOWN_JOB_KIND };
  }

  // Re-verify the handed-off manifest structure before creating anything.
  const mf = verifyGrantManifest(grant);
  if (!mf.ok) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, mf.code ?? ERR_MANIFEST, sc);
    return { code: 'manifest_invalid' };
  }

  const receipt = deps.readReceipt(grant.tenantId, grant.branchId, u, grant.uploadEventId);
  const exists = deps.productExists(grant.entityId);

  if (receipt) {
    if (receipt.payloadHash !== grant.payloadHash) {
      await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_OP_CONFLICT, sc);
      return { code: 'operation_conflict' };
    }
    if (receipt.entityId !== grant.entityId || !exists) {
      await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_RECEIPT_INCONSISTENT, sc);
      return { code: 'operation_conflict' };
    }
    // Resume: product + matching receipt are already durable — just finish/verify + ready.
    return finishReady(grant, deps, 'resumed', entryRevision, sc);
  }

  if (exists) {
    // A product with our target id exists but has NO source receipt → foreign; never overwrite.
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_TARGET_CONFLICT, sc);
    return { code: 'target_conflict' };
  }

  // Normal create. Prepare every image OUT-OF-BAND (Rust reads staging + renders → opaque
  // descriptors; no bytes/data-URLs in JS), then product + receipt in ONE durable checkpoint,
  // entityId pinned, the full-metadata projection hash bound into the receipt.
  let prepared: PreparedMediaItem[];
  try {
    prepared = await deps.preparePreparedMedia(grant, sc);
  } catch (e) {
    // A3 fence (fresh read): if the binding changed during prepare, do not write a terminal state.
    if (await claimFenced(deps, entryRevision)) {
      await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
      return { code: 'deferred', detail: 'scope_fenced' };
    }
    if (e instanceof MaterializeError && e.kind === 'broken') {
      await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_MANIFEST, sc);
      return { code: 'manifest_invalid' };
    }
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc); // token lost / transient → retry
    return { code: 'deferred', detail: 'prepare_unavailable' };
  }
  // A3 fence (fresh read) immediately before the durable product+receipt checkpoint.
  if (await claimFenced(deps, entryRevision)) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'scope_fenced' };
  }
  // SKU-ALLOC — a phone upload normally carries no SKU, so the number is allocated HERE, at the
  // moment the product is written, and never on the phone: only the desktop sees every SKU in use,
  // and "next free" is only true at insert time. It is folded into the metadata BEFORE the hash, so
  // the receipt binds exactly what the row will contain — hash it after the fact and the pre-ready
  // projection check would find a SKU that was never bound and quarantine the job.
  const created = withAllocatedSku(grant, deps);
  const metadataHash = await canonicalProductMetadataHash(projectionFieldsFromMetadata(created.metadataJson));
  const manifestHash = await preparedManifestHash(grant.images, identitiesFromPrepared(prepared));
  const result = await deps.createProduct(created, prepared, {
    uploadEventId: grant.uploadEventId,
    payloadHash: grant.payloadHash,
    authenticatedUserId: grant.authenticatedUserId,
    canonicalProductMetadataHash: metadataHash,
    preparedManifestHash: manifestHash,
  });
  if (result.status === 'product_save_failed') {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc); // nothing durable → retry later
    return { code: 'deferred', detail: result.errorCode };
  }
  // 'created' or 'media_incomplete' → product durable. Verify before marking ready.
  return finishReady(grant, deps, 'ready', entryRevision, sc);
}

/** Die Felder, die ein mobiler Text-Edit setzen darf. Bewusst eng und bewusst OHNE `sku`, Preise,
 *  Kategorie, Attribute oder irgendetwas Bildbezogenes: was hier nicht steht, kann vom Handy aus
 *  gar nicht geschrieben werden. */
export const MOBILE_TEXT_EDIT_FIELDS: ReadonlySet<string> = new Set([
  'name', 'brand', 'condition', 'storageLocation', 'notes',
]);

/** Traegt dieser Job den Edit-Marker? Er sitzt in der Metadata (die Inbox-Tabelle laesst per CHECK
 *  nur `mode='collection'` zu) und geht in den payload_hash ein, ist also genauso bindend. */
export function isMobileTextEditJob(metadataJson: string): boolean {
  try { return (JSON.parse(metadataJson) as { kind?: unknown } | null)?.kind === 'text_edit'; } catch { return false; }
}

/** Die Job-Art, wie sie in der Metadata steht — Spiegel von `mobile_job_kind()` in Rust.
 *  FEHLENDES `kind` ist ein Create (so kommt jeder Create-Job). Ein VORHANDENES, unbekanntes `kind`
 *  ist ausdruecklich `unknown` und wird abgelehnt, nicht als Create durchgereicht. */
export function mobileJobKindMarker(metadataJson: string): 'create' | 'text_edit' | 'gallery_edit' | 'unknown' {
  let meta: { kind?: unknown } | null;
  try { meta = JSON.parse(metadataJson) as { kind?: unknown } | null; } catch { return 'unknown'; }
  if (!meta || typeof meta !== 'object') return 'unknown';
  if (!('kind' in meta)) return 'create';
  if (meta.kind === 'text_edit') return 'text_edit';
  if (meta.kind === 'gallery_edit') return 'gallery_edit';
  return 'unknown';
}

/** Den Patch aus der Job-Metadata lesen — fail closed: unbekannte Felder machen den Job ungueltig,
 *  statt still ignoriert zu werden (sonst koennte ein Client glauben, er habe etwas gesetzt). */
export function parseMobileTextEdit(metadataJson: string): { ok: true; productId: string; patch: MobileProductPatch } | { ok: false; code: string } {
  let meta: unknown;
  try { meta = JSON.parse(metadataJson); } catch { return { ok: false, code: ERR_EDIT_PATCH_INVALID }; }
  const productId = (meta as { productId?: unknown } | null)?.productId;
  if (typeof productId !== 'string' || productId === '') return { ok: false, code: ERR_EDIT_PATCH_INVALID };
  const parsed = parseMobileProductPatch((meta as { patch?: unknown } | null)?.patch);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return { ok: true, productId, patch: parsed.patch };
}

/**
 * Den gelesenen Patch gegen den AKTUELLEN Stand und die Kategorie-SSOT aufloesen — inklusive der
 * Herkunftsfrage bei Preisen.
 *
 * Preise duerfen vom Handy aus nur an einem Artikel geaendert werden, fuer den es noch keinerlei
 * Beschaffungs- oder Kostenbeleg gibt. Das ist keine Schaetzung aus SKU, Datum oder Kategorie,
 * sondern eine Aussage ueber echte Relationen: keine Einkaufszeile, kein Lot, Eigenbestand. Nur
 * dann ist `products.purchase_price` ueberhaupt die Grundlage — sobald ein Lot existiert, rechnet
 * die Bewertung mit dessen `unit_cost`, und eine Korrektur hier waere wirkungslos oder irrefuehrend.
 */
function resolvePatchForApply(
  productId: string,
  patch: MobileProductPatch,
  deps: MobileDrainDeps,
): { ok: true; resolved: Record<string, unknown> } | { ok: false; code: string } {
  if (patchTouchesPrices(patch)) {
    if (!deps.priceEditAllowed) return { ok: false, code: ERR_PRICE_NOT_ELIGIBLE };
    if (!deps.priceEditAllowed(productId)) return { ok: false, code: ERR_PRICE_NOT_ELIGIBLE };
  }
  if (!deps.readProductState || !deps.fieldSchema) return { ok: false, code: ERR_EDIT_PATCH_INVALID };
  const current = deps.readProductState(productId);
  if (!current) return { ok: false, code: ERR_TARGET_CONFLICT };
  return resolveMobileProductPatch(patch, current, deps.fieldSchema());
}

/**
 * MOBILE-EDIT-S2 — Textfelder eines bestehenden Artikels anwenden.
 *
 * Sicherheitsgrenzen, alle fail-closed:
 *   • das Produkt MUSS existieren (sonst waere es ein verkappter Create),
 *   • Bilder im Edit-Job werden NICHT verarbeitet — der Galerie-Edit ist eine eigene Stufe, und ein
 *     halb verstandener Job wird quarantaeniert statt teilweise ausgefuehrt,
 *   • der Patch darf nur die freigegebenen Textfelder tragen,
 *   • angewandt wird ueber den kanonischen durablen Textedit, der `media_links` nicht anfasst.
 * Idempotenz: derselbe uploadEventId wird vom Rust-Inbox-Vertrag nur einmal `ready`; und der
 * Textedit selbst ist replay-sicher (Baseline-Guard: Ziel bereits erreicht → no-op).
 *
 * FEHLERKLASSIFIKATION (MOBILE-EDIT-S2-R1) — ein Job muss in dem Zustand landen, aus dem er wieder
 * herauskommt, und NUR dann. Die Trennlinie ist nicht "wie schlimm", sondern: kann derselbe Job
 * durch blosse Wiederholung jemals gelingen?
 *
 *   PERMANENT → `markQuarantined` mit stabilem Code, terminal, nie wieder beansprucht:
 *     • Ziel existiert nicht                    → MOBILE_UPLOAD_TARGET_CONFLICT
 *     • Patch malformed / verbotenes Feld       → MOBILE_EDIT_PATCH_INVALID
 *     • Text-Edit bringt Bilder mit             → MOBILE_EDIT_GALLERY_NOT_SUPPORTED
 *   Alle drei sind Eigenschaften des Jobs selbst und aendern sich durch Warten nicht.
 *
 *   TRANSIENT → `release`, der Job bleibt beanspruchbar:
 *     • Scope-Fence / Rebind waehrend des Claims  — der naechste Lauf hat wieder einen gueltigen Scope
 *     • `applyTextEdit` fehlt (nicht verdrahtet)  — ein spaeterer, vollstaendiger Lauf holt ihn ab
 *     • `applyTextEdit` wirft                     — nichts wurde durabel, ein Retry ist sinnvoll
 *     • `applyTextEdit` meldet !ok                — die drei moeglichen Gruende sind alle aufloesbar:
 *       fehlender Scope (kommt mit dem Login), BASELINE_CHANGED (die Baseline wird bei JEDEM Versuch
 *       frisch aus der aktuellen Zeile abgeleitet, ein Konflikt ist also ein Rennen, kein Zustand)
 *       und ein noch nicht durchgefuehrter Legacy-Cutover (den der Desktop nachholt).
 *
 * Kein Versuchszaehler, keine eigene Retry-Mechanik: das unbegrenzte Wiederholen eines transienten
 * Fehlers ist die bestehende Eigenschaft des GESAMTEN Mobile-Drains (der Create-Zweig verhaelt sich
 * bei `product_save_failed` identisch) und waere hier weder neu einzufuehren noch allein zu aendern.
 * Bewiesen in `test/mobile-edit-failure/edit-failure-classification.test.ts` am persistierten
 * Job-Zustand und am Claim-Zaehler, inklusive Negativkontrolle.
 */
async function processEditClaim(grant: ClaimGrant, deps: MobileDrainDeps, sc: DrainScope, entryRevision: number): Promise<DrainOutcome> {
  const u = grant.authenticatedUserId;
  if (!deps.applyTextEdit) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'edit_not_wired' };
  }
  const parsed = parseMobileTextEdit(grant.metadataJson);
  if (!parsed.ok) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, parsed.code, sc);
    return { code: 'manifest_invalid', detail: parsed.code };
  }
  if (!deps.productExists(parsed.productId)) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_TARGET_CONFLICT, sc);
    return { code: 'target_conflict' };
  }
  if (grant.images.length > 0) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_EDIT_GALLERY_UNSUPPORTED, sc);
    return { code: 'manifest_invalid', detail: ERR_EDIT_GALLERY_UNSUPPORTED };
  }
  // Gegen den AKTUELLEN Stand aufloesen: Attribute mergen, Auswahlwerte und Abhaengigkeiten gegen
  // die Kategorie-SSOT pruefen, und bei Preisen die Herkunft. Alles davon ist deterministisch —
  // scheitert es, ist der Job terminal und wird nicht endlos wiederholt.
  const resolvedEdit = resolvePatchForApply(parsed.productId, parsed.patch, deps);
  if (!resolvedEdit.ok) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, resolvedEdit.code, sc);
    return { code: 'manifest_invalid', detail: resolvedEdit.code };
  }
  // Fence direkt vor der einzigen Mutation dieses Zweigs.
  if (await claimFenced(deps, entryRevision)) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'scope_fenced' };
  }
  let applied: { ok: boolean; errorCode?: string };
  try {
    applied = await deps.applyTextEdit(parsed.productId, resolvedEdit.resolved);
  } catch (e) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc); // nichts durabel → spaeter erneut
    return { code: 'deferred', detail: (e as { message?: string })?.message ?? 'edit_failed' };
  }
  if (!applied.ok) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: applied.errorCode ?? 'edit_failed' };
  }
  if (await claimFenced(deps, entryRevision)) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'scope_fenced' };
  }
  const res = await deps.bridge.markReady(
    u, grant.uploadEventId, grant.claimToken, grant.entityId, grant.payloadHash, parsed.productId, sc,
  );
  return res === 'rejected' ? { code: 'ready_rejected' } : { code: 'ready' };
}

/** Traegt dieser Job den Galerie-Edit-Marker? Wie beim Textedit sitzt er in der Metadata und ist
 *  ueber den `payload_hash` gebunden. */
export function isMobileGalleryEditJob(metadataJson: string): boolean {
  try { return (JSON.parse(metadataJson) as { kind?: unknown } | null)?.kind === 'gallery_edit'; } catch { return false; }
}

/** Fehler, deren Wiederholung mit DEMSELBEN Job nie gelingen kann, weil der Plan auf einer
 *  ueberholten oder widerspruechlichen Sicht beruht. §18: fuer den Galerie-Edit ist ein
 *  Baseline-Konflikt ein fachlicher Konflikt, kein Hintergrundrauschen — der Benutzer muss neu
 *  laden. Ein endloses Wiederholen wuerde denselben veralteten Plan immer wieder anwenden wollen. */
const GALLERY_TERMINAL_CODES = [
  'MOBILE_GALLERY_BASELINE_CHANGED',
  'MOBILE_GALLERY_PLAN_INCOMPLETE',
  'MOBILE_GALLERY_TOO_MANY_IMAGES',
  'MOBILE_GALLERY_PLAN_INVALID',
  'MEDIA_EDIT_BASELINE_CHANGED',
  'MEDIA_EDIT_PRODUCT_BASELINE_CHANGED',
  'MEDIA_EDIT_PLAN_CONFLICT',
  'MEDIA_EDIT_KEEP_NOT_IN_BASELINE',
  'MEDIA_EDIT_KEEP_MISSING',
  'MEDIA_EDIT_DUPLICATE_MEDIA',
  'MEDIA_EDIT_NEW_NOT_PREPARED',
  'MEDIA_EDIT_RENDITION_DIVERGED',
] as const;

export function galleryFailureIsTerminal(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  return GALLERY_TERMINAL_CODES.some((c) => errorCode.includes(c));
}

/**
 * MOBILE-EDIT-S3 — die Galerie eines bestehenden Artikels aendern.
 *
 * Der Ablauf ist der des Creates, mit einem anderen Ende: die Bilder werden ueber DENSELBEN
 * Out-of-band-Prepare gestaged (Bytes bleiben in Rust), und statt eines neuen Produkts entsteht ein
 * `EditPlanEnvelope`, den der vorhandene Koordinator in EINER Transaktion anwendet.
 *
 * Sicherheitsgrenzen, alle fail-closed:
 *   • das Produkt MUSS existieren,
 *   • der Plan muss formal gueltig sein (sonst: quarantaeniert, nicht geraten),
 *   • der mitgeschickte Baseline muss dem AKTUELLEN Stand entsprechen — sonst Konflikt,
 *   • der Plan muss die gesehene Galerie vollstaendig abdecken — ein fehlendes Bild ist ein Fehler,
 *     niemals eine Loeschung,
 *   • gestagte, aber nie angewandte Bilder raeumt der bestehende Staging-/GC-Vertrag ab.
 *
 * Fehlerklassifikation wie in S2, mit EINER Verschaerfung (§18): ein Baseline-/Plan-Konflikt ist
 * terminal. Er beruht auf einer Sicht, die es nicht mehr gibt; ein Retry wuerde denselben veralteten
 * Plan erneut anwenden wollen und im schlimmsten Fall ein inzwischen hinzugekommenes Bild treffen.
 */
async function processGalleryEditClaim(grant: ClaimGrant, deps: MobileDrainDeps, sc: DrainScope, entryRevision: number): Promise<DrainOutcome> {
  const u = grant.authenticatedUserId;
  if (!deps.applyGalleryEdit) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'gallery_edit_not_wired' };
  }
  const parsed = parseMobileGalleryPlan(grant.metadataJson);
  if (!parsed.ok) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_GALLERY_PLAN_INVALID, sc);
    return { code: 'manifest_invalid', detail: ERR_GALLERY_PLAN_INVALID };
  }
  if (!deps.productExists(parsed.plan.productId)) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_TARGET_CONFLICT, sc);
    return { code: 'target_conflict' };
  }
  // Jedes hochgeladene Bild braucht seinen Platz im Plan — sonst gehoeren Plan und Batch nicht
  // zusammen. Rust prueft das schon beim Annehmen; hier steht es noch einmal, weil der Drain sich
  // auf die andere Seite nicht verlaesst.
  const newSlots = parsed.plan.order.filter((e): e is { new: number } => typeof (e as { new?: unknown }).new === 'number');
  if (newSlots.length !== grant.images.length) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_GALLERY_PLAN_INVALID, sc);
    return { code: 'manifest_invalid', detail: ERR_GALLERY_PLAN_INVALID };
  }

  // Bilder out-of-band vorbereiten — identisch zum Create-Zweig. Schlaegt das fehl, ist NICHTS an
  // der Galerie passiert: der Plan wird erst danach gebaut und angewandt.
  let prepared: PreparedMediaItem[] = [];
  if (grant.images.length > 0) {
    try {
      prepared = await deps.preparePreparedMedia(grant, sc);
    } catch (e) {
      if (await claimFenced(deps, entryRevision)) {
        await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
        return { code: 'deferred', detail: 'scope_fenced' };
      }
      if (e instanceof MaterializeError && e.kind === 'broken') {
        await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_MANIFEST, sc);
        return { code: 'manifest_invalid' };
      }
      await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
      return { code: 'deferred', detail: 'prepare_unavailable' };
    }
  }
  // Fence direkt vor der einzigen Mutation dieses Zweigs.
  if (await claimFenced(deps, entryRevision)) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'scope_fenced' };
  }

  // v0.8.48 §17 — bringt der Save auch Feldaenderungen mit, werden sie JETZT gegen den aktuellen
  // Stand aufgeloest und wandern zusammen mit dem Bildplan in dieselbe Transaktion. Scheitert die
  // Aufloesung, wird gar nichts angewandt — weder Felder noch Bilder.
  let planForApply = parsed.plan;
  if (parsed.plan.patch) {
    const res = resolvePatchForApply(parsed.plan.productId, parsed.plan.patch as MobileProductPatch, deps);
    if (!res.ok) {
      await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, res.code, sc);
      return { code: 'manifest_invalid', detail: res.code };
    }
    planForApply = { ...parsed.plan, patch: res.resolved };
  }

  let applied: { ok: boolean; errorCode?: string };
  try {
    applied = await deps.applyGalleryEdit(grant, prepared, planForApply);
  } catch (e) {
    applied = { ok: false, errorCode: (e as { message?: string })?.message ?? 'gallery_edit_failed' };
  }
  if (!applied.ok) {
    if (galleryFailureIsTerminal(applied.errorCode)) {
      const code = applied.errorCode ?? ERR_GALLERY_PLAN_INVALID;
      await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, code, sc);
      return { code: 'operation_conflict', detail: code };
    }
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: applied.errorCode ?? 'gallery_edit_failed' };
  }
  if (await claimFenced(deps, entryRevision)) {
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'scope_fenced' };
  }
  const res = await deps.bridge.markReady(
    u, grant.uploadEventId, grant.claimToken, grant.entityId, grant.payloadHash, parsed.plan.productId, sc,
  );
  return res === 'rejected' ? { code: 'ready_rejected' } : { code: 'ready' };
}

async function finishReady(grant: ClaimGrant, deps: MobileDrainDeps, successCode: DrainCode, entryRevision: number, sc: DrainScope): Promise<DrainOutcome> {
  const u = grant.authenticatedUserId;
  // MOBILE-04B2A3 — a scope/revision change during the (async) verify + mark sequence must never
  // produce a ready or quarantine write from this now-stale claim. Re-check on entry and again
  // right before the terminal mark.
  if (await claimFenced(deps, entryRevision)) { await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc); return { code: 'deferred', detail: 'scope_fenced' }; }
  const verdict = await deps.verifyReady(grant);
  if (verdict === 'broken') {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_BROKEN, sc);
    return { code: 'operation_conflict', detail: ERR_BROKEN };
  }
  if (verdict === 'pending') {
    // durable product, media still finishing (startup recovery converges it) → release for a later
    // resume rather than hold the lease or mark a half-ready job.
    await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc);
    return { code: 'deferred', detail: 'pending' };
  }
  // Stored product must match the receipt-bound canonical projection over ALL written fields (not
  // just gallery/receipt): normalise the DB product, recompute the hash, compare to the receipt.
  const receipt = deps.readReceipt(grant.tenantId, grant.branchId, u, grant.uploadEventId);
  const productHash = await deps.readProductMetadataHash(grant.entityId);
  if (!receipt || !productHash || productHash !== receipt.canonicalProductMetadataHash) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_METADATA_MISMATCH, sc);
    return { code: 'operation_conflict', detail: ERR_METADATA_MISMATCH };
  }
  // THREE-WAY reconstruction of the canonical contract from three independent SSOTs — receipt,
  // durable create batch (media_ingest_jobs) and active gallery (media_links) — with EXPLICIT
  // slot/primary proof, not just a sorted set. Any divergence → quarantine, never ready.
  const grantImgs = [...grant.images].sort((a, b) => a.slot - b.slot);
  const gallery = await deps.readGalleryManifest(grant.entityId);
  const batch = await deps.readBoundBatch(grant.entityId);
  const counts = await deps.readSideEffectCounts(grant.entityId);
  const batchHash = await preparedManifestHash(grant.images, identitiesFromBatch(batch));
  const galleryOk = galleryMatchesGrant(gallery, grantImgs);
  if (
    batch.length !== grantImgs.length ||                              // batch: exact count
    batchHash !== receipt.preparedManifestHash ||                     // batch ↔ receipt manifest
    receipt.createBatchId !== deps.deriveCreateBatchId(grant.entityId) || // receipt ↔ deterministic batch id
    !galleryOk ||                                                     // gallery: slots 0..N-1, primary@0, == grant
    counts.changelog !== 1 || counts.audit !== 1                      // exactly one changelog + audit
  ) {
    await deps.bridge.markQuarantined(u, grant.uploadEventId, grant.claimToken, ERR_BATCH_MISMATCH, sc);
    return { code: 'operation_conflict', detail: ERR_BATCH_MISMATCH };
  }
  // Final A3 fence (fresh read) immediately before the terminal write: a rebind after verification
  // must never mark ready.
  if (await claimFenced(deps, entryRevision)) { await deps.bridge.release(u, grant.uploadEventId, grant.claimToken, sc); return { code: 'deferred', detail: 'scope_fenced' }; }
  const outcome = await deps.bridge.markReady(
    u, grant.uploadEventId, grant.claimToken, grant.entityId, grant.payloadHash, grant.entityId, sc,
  );
  if (outcome === 'rejected') return { code: 'ready_rejected' }; // our lease was taken over
  return { code: successCode };
}

/** Drain up to `max` jobs this pass. Stops on the first idle claim (nothing to do) or a rejected
 *  ready (our epoch lost the lease). Returns the per-job outcomes. */
export async function drainMobileUploads(deps: MobileDrainDeps, max = 25): Promise<DrainOutcome[]> {
  const out: DrainOutcome[] = [];
  for (let i = 0; i < max; i++) {
    // R1 §2: read FRESH evidence before EVERY claim — a rebind mid-pass stops the next claim. The
    // validated scope is forwarded into the claim invoke; no scope → no claim (fail closed).
    const fs = await freshScope(deps);
    if (!fs.available || !fs.scope) { out.push({ code: 'scope_blocked' }); break; }
    let grant: ClaimGrant | null;
    try {
      grant = await deps.bridge.claim(deps.claimantInstanceId, MOBILE_DRAIN_LEASE_SECONDS, fs.scope);
    } catch {
      break; // Retryable/transient — stop this pass; the next drain re-drives.
    }
    if (!grant) { out.push({ code: 'idle' }); break; }
    const res = await processMobileUploadClaim(grant, deps);
    out.push(res);
    if (res.code === 'ready_rejected') break;
  }
  return out;
}

// ── the drain worker (single-flight, per-DB/auth-epoch, pause-aware) ──────────
// A long-lived worker, NOT tied to any React component lifecycle. One in-flight drain at a time
// (shared promise); pauses for DB-lifecycle/backup/update; refuses to run outside the current
// authenticated scope; a scope/epoch change ends the old worker (a new one is created for the new
// epoch). It never holds the DB across a swap — each createProductWithMedia takes its own lease.
export class MobileUploadDrainWorker {
  private inFlight: Promise<DrainOutcome[]> | null = null;
  private paused = false;
  private readonly deps: MobileDrainDeps;
  readonly epoch: number;
  /** MOBILE-04B2A3 — the binding revision this worker was minted for (from a fresh read at creation);
   *  a later revision fences it. */
  readonly bindingRevision: number;
  constructor(deps: MobileDrainDeps, epoch: number, bindingRevision: number) { this.deps = deps; this.epoch = epoch; this.bindingRevision = bindingRevision; }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  /** Await any in-flight drain (for lifecycle "wait for idle" before a DB swap/flush). */
  async waitForIdle(): Promise<void> { if (this.inFlight) { try { await this.inFlight; } catch { /* logged in tick */ } } }

  /** Run one drain pass, single-flighted. Skips silently when paused or unauthenticated. */
  async tick(): Promise<DrainOutcome[]> {
    if (this.paused) return [{ code: 'idle' }];
    // R1 §2: read FRESH evidence; block if the scope is unavailable OR the binding revision moved
    // away from the one this worker was minted for (a rebind fences the stale worker).
    const s = await freshScope(this.deps);
    if (!s.available || s.revision !== this.bindingRevision) return [{ code: 'scope_blocked' }];
    if (!this.deps.currentScope()) return [{ code: 'idle' }]; // not authenticated yet
    if (this.inFlight) return this.inFlight; // single-flight: coalesce concurrent triggers
    this.inFlight = drainMobileUploads(this.deps).catch(() => [{ code: 'idle' as const }]);
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }
}

// Module-scoped current worker, keyed by (epoch, scope) — a scope/epoch change replaces it so the
// old one is dropped and never processes the new scope's jobs.
let currentWorker: { key: string; worker: MobileUploadDrainWorker } | null = null;

/** Get-or-create the worker for the given epoch + deps. A different epoch or scope key yields a
 *  fresh worker (the previous one is abandoned). Returns null when unauthenticated. */
export async function getMobileUploadDrainWorker(deps: MobileDrainDeps, epoch: number): Promise<MobileUploadDrainWorker | null> {
  // R1 §2: FRESH read at worker creation. No available binding → no worker at all.
  const s = await freshScope(deps);
  const scope = deps.currentScope();
  if (!s.available || !scope) return null;
  const key = `${epoch}:${scope.tenantId}:${scope.branchId}:${s.revision}`;
  if (!currentWorker || currentWorker.key !== key) {
    currentWorker = { key, worker: new MobileUploadDrainWorker(deps, epoch, s.revision) };
  }
  return currentWorker.worker;
}

/** Fire-and-forget drain trigger — safe to call from boot/post-auth/lifecycle-resume. Never throws
 *  and is a no-op when unauthenticated, paused, or the Rust bridge is unavailable (e.g. web preview
 *  with no Tauri: the claim invoke rejects and the pass simply ends). */
export function triggerMobileUploadDrainSafe(deps: MobileDrainDeps, epoch: number): void {
  // R1 §2: getMobileUploadDrainWorker reads FRESH evidence and returns null while blocked; the tick
  // reads fresh again and fences. Fire-and-forget; never throws.
  void getMobileUploadDrainWorker(deps, epoch).then((w) => { if (w) void w.tick(); }).catch(() => { /* never break the caller */ });
}
