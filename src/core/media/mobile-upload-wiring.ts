// MOBILE-04B2A2 — production wiring for the mobile upload drain worker.
//
// Assembles the real dependencies (Tauri bridge + sql.js queries + productStore.createProductWithMedia
// + ProductMediaResolver) into a MobileDrainDeps, and exposes a guarded fire-and-forget trigger for
// the post-auth / lifecycle-resume path. Kept OUT of mobile-upload-drain.ts so the saga stays
// framework-free and unit-testable. Everything is a no-op without an authenticated scope or without
// Tauri (the claim invoke rejects and the pass ends), so it is safe to call at boot and in the web
// preview. It only processes jobs whose scope matches the current authenticated desktop context; the
// job's ORIGIN user comes from the Rust ClaimGrant, never from JS. Images are prepared in Rust — no
// bytes/data-URLs cross into JS.

import { getDatabase, currentDbEpoch } from '@/core/db/database';
import { allocateSku, type SkuSequenceDb } from '@/core/products/sku-sequence';
import { query, currentBranchId } from '@/core/db/helpers';
import { armDrainPoller, stopDrainPoller, type DrainPollerDeps } from './mobile-drain-poller';
import { runtimeScopeAvailable, runtimeBindingRevisionOf } from './runtime-scope-evidence';
import type { Product } from '@/core/models/types';
import { buildMobileFieldSchema, filterAttributesToSchema, isValidQuantity, type MobileAttrValue } from '@/core/mobile/mobile-field-schema';
import { TauriMediaGateway } from '@/core/media/gateway';
import { ProductMediaResolver } from '@/core/media/product-media-resolver';
import { getStockMediaOrchestrator } from '@/core/media/orchestrator';
import { canonicalRequestHash } from '@/core/media/product-media-cutover';
import { buildMobileGalleryEnvelope, type MobileGalleryPlan } from '@/core/media/mobile-gallery-edit';
import { useProductStore } from '@/stores/productStore';
import {
  createTauriMobileUploadBridge, triggerMobileUploadDrainSafe, canonicalProductMetadataHash, MaterializeError,
  type ClaimGrant, type MobileDrainDeps, type ReadyVerdict, type DurableReceipt, type PreparedMediaItem, type BoundBatchJob, type GallerySlot, type DrainScope,
} from './mobile-upload-drain';
import type { RuntimeScopeEvidence } from './runtime-scope-evidence';

// MOBILE-04B2A3-R1 — the runtime scope source is the Rust-owned canonical binding (v0014), read
// FRESH at every guard boundary. There is NO persistent cached evidence: a once-read revision must
// never outlive a later rebind. The only permitted caching is de-duplicating a SINGLE concurrent
// read (so parallel guards in one tick share one invoke), never returning a stale revision as truth.
// The read command derives the install id server-side; the gate requires an EXACT match to the active
// auth/DB scope. MOBILE-04B2A6-I1: the owner options/configure and the six mutation commands are now
// registered, so activation is scope-gated — until an owner explicitly configures a binding the evidence
// reads `configured=false`, the gate stays closed, and the pipeline processes nothing. The worker still
// starts only on an explicit trigger; registration alone never claims or processes an upload.
let inFlightScopeRead: Promise<RuntimeScopeEvidence | null> | null = null;

/** One FRESH read of the Rust scope evidence, de-duplicating only a concurrent in-flight read. Never
 *  throws; returns null (→ blocked) without Tauri or on any error. */
async function readScopeEvidence(): Promise<RuntimeScopeEvidence | null> {
  if (inFlightScopeRead) return inFlightScopeRead; // dedup ONLY the concurrent read; no lasting cache
  inFlightScopeRead = (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<RuntimeScopeEvidence>('mobile_runtime_scope_evidence');
    } catch {
      return null; // no Tauri / read failed → fail closed
    }
  })();
  try { return await inFlightScopeRead; } finally { inFlightScopeRead = null; }
}

const ROLE = 'stock_image';
// Stable per-JS-session claimant instance id (a reload mints a new one — fine; the Rust lease/token
// enforce single-claim, not this id).
const CLAIMANT_INSTANCE_ID = `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const bridge = createTauriMobileUploadBridge();

function currentScope(): { tenantId: string; branchId: string } | null {
  let branchId: string;
  try { branchId = currentBranchId(); } catch { return null; }
  if (!branchId) return null;
  const rows = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId]);
  const tenantId = rows.length > 0 ? (rows[0].tenant_id as string | null) : null;
  return tenantId ? { tenantId, branchId } : null;
}

function readReceipt(tenantId: string, branchId: string, authenticatedUserId: string, uploadEventId: string): DurableReceipt | null {
  const rows = query(
    'SELECT payload_hash, entity_id, product_id, create_batch_id, canonical_product_metadata_hash, prepared_manifest_hash FROM mobile_upload_receipts WHERE tenant_id = ? AND branch_id = ? AND authenticated_user_id = ? AND upload_event_id = ?',
    [tenantId, branchId, authenticatedUserId, uploadEventId],
  );
  if (rows.length === 0) return null;
  return {
    payloadHash: String(rows[0].payload_hash), entityId: String(rows[0].entity_id),
    productId: String(rows[0].product_id), createBatchId: String(rows[0].create_batch_id),
    canonicalProductMetadataHash: String(rows[0].canonical_product_metadata_hash),
    preparedManifestHash: String(rows[0].prepared_manifest_hash),
  };
}

async function readBoundBatch(entityId: string): Promise<BoundBatchJob[]> {
  const rows = query(
    'SELECT ingest_request_id, request_hash FROM media_ingest_jobs WHERE requested_entity_id = ? AND requested_role = ?',
    [entityId, ROLE],
  );
  return rows.map((r) => ({ ingestRequestId: String(r.ingest_request_id), requestHash: String(r.request_hash) }));
}

async function readGalleryManifest(entityId: string): Promise<GallerySlot[]> {
  const rows = query('SELECT sort_order, is_primary FROM media_links WHERE entity_id = ? AND deleted_at IS NULL ORDER BY sort_order', [entityId]);
  return rows.map((r) => ({ sortOrder: Number(r.sort_order), isPrimary: !!Number(r.is_primary) }));
}
async function readSideEffectCounts(entityId: string): Promise<{ changelog: number; audit: number }> {
  const cl = query(`SELECT COUNT(*) AS n FROM sync_changelog WHERE table_name = 'products' AND record_id = ?`, [entityId]);
  const au = query(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'products' AND entity_id = ?`, [entityId]);
  return { changelog: cl.length ? Number(cl[0].n) : 0, audit: au.length ? Number(au[0].n) : 0 };
}
function deriveCreateBatchId(entityId: string): string {
  const s = currentScope();
  return s ? `create:${s.tenantId}:${s.branchId}:${entityId}:${ROLE}` : '';
}

/** Prepare every image via the Rust media core (bytes stay in Rust) → ordered opaque descriptors. */
async function preparePreparedMedia(grant: ClaimGrant, sc: DrainScope): Promise<PreparedMediaItem[]> {
  const scope = currentScope();
  if (!scope) throw new MaterializeError('unavailable');
  const sorted = [...grant.images].sort((a, b) => a.slot - b.slot);
  const out: PreparedMediaItem[] = [];
  for (const im of sorted) {
    let prepared;
    try {
      // MOBILE-04B2A7-I1 — forward the validated worker scope so prepare_image passes the server fence.
      prepared = await bridge.prepareImage(grant.authenticatedUserId, grant.uploadEventId, grant.claimToken, im.slot, scope.tenantId, sc);
    } catch (e) {
      // A staging integrity/manifest failure is permanent → quarantine; anything else (stale token,
      // transient IPC) → retry. Rust returns MOBILE_UPLOAD_INTEGRITY_FAILURE / _MANIFEST_INVALID.
      const msg = String((e as Error)?.message ?? e);
      throw new MaterializeError(/INTEGRITY|MANIFEST/i.test(msg) ? 'broken' : 'unavailable');
    }
    // The prepared identity is the SERVER-derived request id — JS uses it verbatim, never invents it.
    out.push({ slot: im.slot, isPrimary: im.slot === 0, ingestRequestId: prepared.ingest_request_id, prepared });
  }
  return out;
}

// MOBILE-FIELDS — the desktop field SSOT (built once) used to allow-list mobile attribute keys on the drain.
const MOBILE_FIELD_SCHEMA = buildMobileFieldSchema();

function collectionDataFromGrant(grant: ClaimGrant): Partial<Product> {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(grant.metadataJson) as Record<string, unknown>; } catch { meta = {}; }
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : undefined);
  // MOBILE-PRICING — a defensive read of an optional price (the server already validated it on v2). Only a
  // finite, non-negative number survives; anything else becomes undefined (→ desktop null/default), so a
  // bypassed gate can never write a bad price. No upper bound (the desktop SSOT has none) and no rounding.
  const price = (k: string): number | undefined => {
    const v = meta[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  // MOBILE-QUANTITY — a defensive read of the optional piece count (the server already validated it
  // on v2). Only a whole number ≥ 1 survives; anything else becomes undefined, which the create path
  // turns into the canonical default of 1. Absent is normal: every payload written before this field
  // existed simply has no key, and those items are exactly one piece.
  const quantity = isValidQuantity(meta.quantity) ? (meta.quantity as number) : undefined;
  const categoryId = str('categoryId') ?? '';
  // MOBILE-FIELDS — the server already allow-listed the metadata against the SSOT; we re-filter attributes to
  // the category's known keys as defense-in-depth (drop anything not in the field schema), and carry the full
  // desktop-parity set (condition + Included/scopeOfDelivery + attributes) through to the product.
  const rawAttrs = (meta.attributes && typeof meta.attributes === 'object' && !Array.isArray(meta.attributes))
    ? (meta.attributes as Record<string, MobileAttrValue>) : {};
  const attributes = filterAttributesToSchema(categoryId, rawAttrs, MOBILE_FIELD_SCHEMA);
  const scope = Array.isArray(meta.scopeOfDelivery)
    ? (meta.scopeOfDelivery as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
  return {
    categoryId,
    brand: str('brand') ?? '',
    name: str('name') ?? '',
    sku: str('sku'),
    ...(str('condition') !== undefined ? { condition: str('condition') } : {}),
    ...(scope !== undefined ? { scopeOfDelivery: scope } : {}),
    // MOBILE-PRICING — carry the three canonical prices through to createProductWithMedia, which already
    // persists purchase_price/planned_sale_price/min_sale_price (and derives expected_margin) on insert.
    ...(price('purchasePrice') !== undefined ? { purchasePrice: price('purchasePrice') } : {}),
    ...(price('plannedSalePrice') !== undefined ? { plannedSalePrice: price('plannedSalePrice') } : {}),
    ...(price('minSalePrice') !== undefined ? { minSalePrice: price('minSalePrice') } : {}),
    // MOBILE-QUANTITY — carry the piece count to createProductWithMedia, which already writes
    // `products.quantity` (clamped to ≥1). Omitted when absent so the existing default applies.
    ...(quantity !== undefined ? { quantity } : {}),
    attributes: attributes as Record<string, unknown>,
    images: [], // prepared mode: media flows via prepared descriptors, never data URLs
  } as Partial<Product>;
}

async function readProductMetadataHash(productId: string): Promise<string | null> {
  const rows = query('SELECT brand, name, category_id, sku, attributes FROM products WHERE id = ?', [productId]);
  if (rows.length === 0) return null;
  const r = rows[0];
  let attrs: unknown = {};
  try { attrs = r.attributes ? JSON.parse(String(r.attributes)) : {}; } catch { attrs = {}; }
  return canonicalProductMetadataHash({ brand: r.brand, name: r.name, categoryId: r.category_id, sku: r.sku, attributes: attrs });
}

async function verifyReady(grant: ClaimGrant): Promise<ReadyVerdict> {
  const scope = currentScope();
  if (!scope) return 'pending';
  const resolver = new ProductMediaResolver({
    dbProvider: () => getDatabase() as never, gateway: new TauriMediaGateway(),
    tenantId: scope.tenantId, branchId: scope.branchId,
  });
  const r = await resolver.resolveProductMedia(grant.entityId);
  if (r.kind === 'pending') return 'pending';           // media still finishing → resume later
  if (r.kind !== 'media') return 'broken';              // legacy/conflict/integrity → fail closed
  const imgs = query('SELECT images FROM products WHERE id = ?', [grant.entityId]);
  if (imgs.length === 0 || String(imgs[0].images) !== '[]') return 'broken'; // no base64 in products.images
  if (r.items.length !== grant.images.length) return 'broken';               // gallery == ordered manifest
  return 'ready';
}

/** Assemble the production drain dependencies. Safe to build anytime; nothing runs until `tick`. */
export function buildMobileUploadDrainDeps(): MobileDrainDeps {
  return {
    bridge,
    claimantInstanceId: CLAIMANT_INSTANCE_ID,
    // MOBILE-04B2A3-R1: the gate reads the Rust canonical binding FRESH each time and the drain
    // compares it EXACTLY to the active scope + fences on the binding revision. Never a hardcoded
    // fallback. Unconfigured (production) → blocked before any claim, however the drain is entered.
    readScopeEvidence,
    currentScope,
    readReceipt,
    productExists: (id) => query('SELECT 1 FROM products WHERE id = ?', [id]).length > 0,
    // SKU-ALLOC §A3 — the DURABLE allocator, not a scan of the current products: a scan would
    // re-issue the number of any product that has since been deleted. The counter is incremented
    // before it is read, so two drains in the same tick cannot claim the same number.
    allocateSku: (seed) => allocateSku(getDatabase() as unknown as SkuSequenceDb, seed),
    readProductMetadataHash,
    readBoundBatch,
    readGalleryManifest,
    readSideEffectCounts,
    deriveCreateBatchId,
    preparePreparedMedia,
    createProduct: (grant, prepared, receiptIntent) =>
      useProductStore.getState().createProductWithMedia(collectionDataFromGrant(grant), grant.entityId, receiptIntent, { kind: 'prepared_media', items: prepared }),
    verifyReady,
    // MOBILE-EDIT-S2 — der Textedit vom Handy laeuft durch GENAU dieselbe Store-Aktion wie der
    // Desktop-Textedit: `editProductTextDurably` diffed die freigegebenen Spalten, wendet sie in
    // einer Transaktion an und ruehrt `media_links` nicht an. Keine zweite Merge-Semantik.
    applyTextEdit: async (entityId, patch) => {
      const res = await useProductStore.getState().editProductTextDurably(entityId, patch as Record<string, never>);
      return res.status === 'edited'
        ? { ok: true }
        : { ok: false, errorCode: (res as { errorCode?: string }).errorCode ?? res.status };
    },
    applyGalleryEdit,
  };
}

/**
 * MOBILE-EDIT-S3 — den Galerie-Plan vom Handy durabel anwenden.
 *
 * Es gibt hier bewusst KEINE eigene Galerie-Logik. Der Ablauf ist der des Desktops:
 * `prepareAndRegisterEdit` liest den Baseline unter der Sperre und friert den Plan ein,
 * `applyEditDurably` wendet ihn in EINER Transaktion an. Der Unterschied ist allein, dass die neuen
 * Bilder schon out-of-band in Rust vorbereitet sind (der Drain uebergibt fertige Deskriptoren, keine
 * Bytes) und dass `buildMobileGalleryEnvelope` vor dem Bauen prueft, ob die Galerie noch die ist,
 * die der Benutzer gesehen hat.
 *
 * Die Batch-Id ist aus dem `uploadEventId` abgeleitet und damit ueber Neustarts hinweg stabil: ein
 * wiederaufgenommener Job landet auf demselben Plan, und ein bereits angewandter ist ein No-op.
 */
async function applyGalleryEdit(
  grant: ClaimGrant,
  prepared: PreparedMediaItem[],
  plan: MobileGalleryPlan,
): Promise<{ ok: boolean; errorCode?: string }> {
  const scope = currentScope();
  if (!scope) return { ok: false, errorCode: 'MEDIA_EDIT_SCOPE_REQUIRED' };
  const preparedBySlot = new Map(prepared.map((p) => [p.slot, { requestId: p.ingestRequestId, prepared: p.prepared }]));
  const batchId = `gallery-edit:${scope.tenantId}:${scope.branchId}:${plan.productId}:${ROLE}:${grant.uploadEventId}`;
  try {
    const orchestrator = await getStockMediaOrchestrator();
    const env = await orchestrator.prepareAndRegisterEdit(
      { tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId, entityType: 'product', entityId: plan.productId, role: ROLE },
      [], // die Bilder sind bereits vorbereitet — hier wird nichts mehr gestaged
      async (baseline) => buildMobileGalleryEnvelope({
        plan, baseline, preparedBySlot, batchId,
        tenantId: scope.tenantId, branchId: scope.branchId, entityId: plan.productId, role: ROLE,
        // Dieselbe Plan-Hash-Funktion wie auf dem Desktop — der Plan-Hash ist die Identitaet des
        // eingefrorenen Plans, und beide Wege muessen fuer denselben Plan denselben Wert liefern.
        digestHex: (s) => canonicalRequestHash(new TextEncoder().encode(s), 'edit-plan'),
      }),
    );
    await orchestrator.applyEditDurably(env);
  } catch (e) {
    return { ok: false, errorCode: (e as { message?: string })?.message ?? 'MEDIA_EDIT_FAILED' };
  }
  useProductStore.getState().loadProducts();
  return { ok: true };
}

/** Fire-and-forget drain trigger for the post-auth / media-recovery-complete / lifecycle-resume
 *  path. Never throws; a no-op without an authenticated scope or without Tauri. */
export function triggerMobileUploadDrainPostAuth(epoch: number): void {
  // MOBILE-04B2A3-R1: no pre-refresh — the drain reads FRESH Rust evidence at worker creation and at
  // every guard, so it can never act on a stale revision. In production the binding is unconfigured →
  // the gate blocks before any claim; the seed constants are never a fallback. Never throws.
  triggerMobileUploadDrainSafe(buildMobileUploadDrainDeps(), epoch);
}

// MOBILE-04B2A13 — bounded interval for the drain poller. Long enough to be a cheap background
// heartbeat, short enough that a later-arriving job becomes visible within a few seconds.
const DRAIN_POLL_INTERVAL_MS = 15_000;

/** Real-dependency poller lifecycle. The timer is BOUND to the authorized scope key and delegates each
 *  tick to the EXISTING trigger (fresh scope read + revision fence + its own single-flight); the poller
 *  adds only the timing + arming contract. */
function buildDrainPollerDeps(): DrainPollerDeps {
  return {
    intervalMs: DRAIN_POLL_INTERVAL_MS,
    setIntervalFn: (fn, ms) => setInterval(fn, ms),
    clearIntervalFn: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    // FRESH authorized scope key: non-null ONLY when authenticated AND evidence.configured AND the
    // binding matches the active scope, keyed on the binding revision so any rebind changes the key.
    computeScopeKey: async () => {
      const scope = currentScope();               // null → not authenticated
      if (!scope) return null;
      const ev = await readScopeEvidence();        // FRESH; null (no Tauri / read error) → not armable
      if (!runtimeScopeAvailable(ev, scope)) return null; // not configured / mismatch → not armable
      return `${scope.tenantId}:${scope.branchId}:${runtimeBindingRevisionOf(ev)}`;
    },
    // Delegate to the existing gated trigger at the CURRENT epoch (a DB reload → new epoch → new worker).
    triggerDrain: () => triggerMobileUploadDrainPostAuth(currentDbEpoch()),
  };
}

/** Arm the bounded drain poller for the current authorized scope (a no-op — and NO timer — until an
 *  owner has configured a matching binding). Called from the post-auth path (arms if already configured)
 *  AND after a successful owner configure/rebind (arms/replaces for the new scope). Idempotent: a second
 *  arm for the same scope never stacks a duplicate timer. */
export function armMobileDrainPoller(): void {
  void armDrainPoller(buildDrainPollerDeps());
}

/** Stop the drain poller (logout / shutdown). Idempotent. */
export function stopMobileDrainPoller(): void {
  stopDrainPoller({ clearIntervalFn: (h) => clearInterval(h as ReturnType<typeof setInterval>) });
}
