// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2B — durable new-product-with-media create flow.
//
// The strict order a new product must follow so a crash or a partial failure
// never loses the product OR leaves a base64 image in `products.images`:
//
//   1. one stable product id (reused verbatim on retry)
//   2. INSERT the product with images='[]' (NO base64 in the row)
//   3. record the DURABLE insert side effects in-memory (sync changelog + audit)
//   4. checkpoint product + N batch-intents + sync/audit TOGETHER, atomically,
//      BEFORE any Rust publish — so a crash after the checkpoint leaves a fully
//      sync-visible, audited product that startup-recovery can finish
//   5. append the selected images, in order, through the durable media pipeline
//   6. only report full success once every image is durably in the gallery
//
// Framework-agnostic + fully injected (same pattern as the cutover/orchestrator
// layers), so the whole flow is node-testable and the productStore is a thin
// wiring layer. The pure `decideProductCreateUi` encodes the modal's
// close/keep-open decision so the UI branch is testable without a React
// renderer.
//
// NEVER logs base64 or image bytes.
// ════════════════════════════════════════════════════════════════════════════

import type { DecodedLegacyImage } from './product-media-cutover.ts';
import { decodeDataUrl } from './product-media-cutover.ts';

// ── result contract ─────────────────────────────────────────────────────────

export type ProductCreateResult =
  /** Product durable AND every image durably in the media gallery. */
  | { status: 'created'; productId: string }
  /** Product is durable, but its images are not fully in place yet. The id is
   *  retained so a retry reuses it — no second product, no duplicate links. */
  | { status: 'media_incomplete'; productId: string; errorCode: string }
  /** The product row itself did not become durable → nothing was published,
   *  no success. Safe to retry with the same id (the row is not on disk). */
  | { status: 'product_save_failed'; productId: string; errorCode: string };

// ── injected pieces ─────────────────────────────────────────────────────────

export interface CreateProductMediaDeps {
  /** The FROZEN original create intent for a retry: the exact ordered image
   *  list the first attempt used. When present, `imageDataUrls` MUST match it —
   *  a differing list is a typed conflict (`MEDIA_CREATE_RETRY_INTENT_MISMATCH`),
   *  never a silent overwrite or a new slot. Absent on a fresh create. */
  expectedImages?: string[];
  /** True if a durable product row with this id already exists (retry path). */
  productExists: (productId: string) => boolean;
  /** INSERT the product row with `images='[]'` (no base64). Called once, only
   *  when the row does not yet exist. */
  insertProductRow: (productId: string) => void;
  /** Record the DURABLE insert side effects (sync changelog + audit row) for a
   *  freshly inserted product, IN-MEMORY, so the next checkpoint persists them
   *  atomically with the product row and the batch intents. Runs BEFORE the
   *  checkpoint, only for a fresh insert. A crash after the checkpoint therefore
   *  leaves a fully sync-visible, audited product — never a durable product with
   *  no changelog. Its rows are undone by `rollbackProductRow` on a save
   *  failure. Must be safe to call once per fresh insert (not called on retry,
   *  so no duplicate changelog). */
  recordDurableInsert?: (productId: string) => void;
  /** Undo a just-inserted (not yet durable) row AND any in-memory batch job
   *  rows for it AND its recorded sync/audit rows — so a failed batch checkpoint
   *  leaves NO ghost product, NO orphan ingest-job and NO stranded changelog.
   *  Called only when the batch never became durable, for a row this call
   *  inserted. */
  rollbackProductRow?: (productId: string) => void;
  /** Durable persist of the product row alone. Used only when there are no
   *  decodable images to batch (empty create, or a decode failure). Throws on
   *  failure. */
  saveDurably: () => Promise<void>;
  /** Build the per-slot ingest inputs for a durable batch: one item per image,
   *  each carrying its computed content hash, fixed slot and the shared batch
   *  grouping (batchId + expectedCount). Async because hashing is async. */
  buildBatchItems: (productId: string, images: DecodedLegacyImage[]) => Promise<unknown[]>;
  /** Phase 1: prepare + register every slot's intent, then ONE durable save
   *  (the atomic product + N-intents batch checkpoint). Throws on failure. */
  prepareAndRegisterBatch: (items: unknown[]) => Promise<void>;
  /** Phase 2: publish + link every slot, then persist. Idempotent per slot. */
  finalizeBatch: (items: unknown[]) => Promise<unknown>;
  /** TRANSIENT post-durable-insert side effects only (event bus / store
   *  reload). The DURABLE ones live in `recordDurableInsert` and land in the
   *  checkpoint; these are rebuilt by the normal load after a restart, so
   *  losing them to a crash is harmless. Runs exactly once, for a freshly
   *  inserted row, AFTER the durable save. */
  onProductInserted?: (productId: string) => void;
  /** Full-success side effects, e.g. kicking off AI embedding. Runs on EVERY
   *  full success — the fresh create AND a later retry that finally completes
   *  the media — because a partial first attempt never reaches full success.
   *  Its own body is responsible for exactly-once (e.g. a durable
   *  already-computed marker), so a create + a completing retry fire the effect
   *  at most once overall. */
  onFullSuccess?: (productId: string, firstImageDataUrl: string | undefined) => void;
  /** Decode a data: URL to bytes. Defaults to the shared data: URL decoder. */
  decode?: (src: string) => DecodedLegacyImage;
}

// ── the flow ────────────────────────────────────────────────────────────────

/**
 * Create one product and its ordered media, durably. See the module header for
 * the exact ordering guarantees. `imageDataUrls` are the base64 data URLs the
 * ImageUpload produced; they are decoded to bytes and NEVER written to
 * `products.images`.
 */
export async function createProductWithDurableMedia(
  productId: string,
  imageDataUrls: string[],
  deps: CreateProductMediaDeps,
): Promise<ProductCreateResult> {
  const decode = deps.decode ?? decodeDataUrl;

  // Retry-intent freeze: a retry MUST reproduce the exact original ordered
  // image list. A different list is a typed conflict — refused before any DB or
  // media touch, so nothing is overwritten and no new slot is opened.
  if (deps.expectedImages && !sameImageIntent(deps.expectedImages, imageDataUrls)) {
    return { status: 'media_incomplete', productId, errorCode: 'MEDIA_CREATE_RETRY_INTENT_MISMATCH' };
  }

  const freshInsert = !deps.productExists(productId);

  // Decode every image first. A bad data URL means we cannot build the batch —
  // still create the product (durably, alone) so the user can retry with valid
  // images, and report `media_incomplete`.
  let decoded: DecodedLegacyImage[];
  try {
    decoded = imageDataUrls.map((src) => decode(src));
  } catch (e) {
    if (freshInsert) {
      deps.insertProductRow(productId);
      // Durable sync/audit rows in-memory BEFORE the save so the checkpoint
      // persists them atomically with the product row.
      deps.recordDurableInsert?.(productId);
      try {
        await deps.saveDurably();
      } catch (se) {
        deps.rollbackProductRow?.(productId);
        return { status: 'product_save_failed', productId, errorCode: asMessage(se) };
      }
      deps.onProductInserted?.(productId);
    }
    return { status: 'media_incomplete', productId, errorCode: `MEDIA_CREATE_DECODE_FAILED:${asMessage(e)}` };
  }

  // Build the per-slot batch items (hash + slot + batch grouping).
  const items = await deps.buildBatchItems(productId, decoded);

  // Phase 1 — insert the product (in-memory) then prepare + register EVERY
  // slot's intent and persist ONCE: product row + N ingest-job intents become
  // durable together, BEFORE any publish. From here a crash is fully
  // recoverable from the DB alone (no JS map). A fresh insert whose batch
  // checkpoint never lands is rolled back — no ghost product, no orphan job,
  // no event/embedding/publish.
  if (freshInsert) {
    deps.insertProductRow(productId);
    // Durable sync/audit rows in-memory now, so the batch checkpoint below
    // persists product + N intents + sync/audit as ONE atomic durable unit
    // BEFORE any Rust publish begins. Only on a fresh insert → no duplicate
    // changelog on a retry (retry never re-enters this branch).
    deps.recordDurableInsert?.(productId);
  }
  try {
    await deps.prepareAndRegisterBatch(items);
  } catch (e) {
    if (freshInsert) {
      deps.rollbackProductRow?.(productId);
      return { status: 'product_save_failed', productId, errorCode: asMessage(e) };
    }
    // A retry: the product is already durable; the batch just isn't complete.
    return { status: 'media_incomplete', productId, errorCode: asMessage(e) };
  }
  // The batch (product + intents) is now durable → the product officially
  // exists. Emit its insert side effects exactly once, for a fresh row.
  if (freshInsert) deps.onProductInserted?.(productId);

  // Phase 2 — publish + link every slot, then persist. A failure here leaves
  // the batch recoverable (the remaining accepted jobs finish via recover()).
  try {
    await deps.finalizeBatch(items);
  } catch (e) {
    return { status: 'media_incomplete', productId, errorCode: asMessage(e) };
  }

  // 5) Full success — fresh create OR a retry that finally completed the media.
  //    The effect fires on both (a partial attempt never reached here); its own
  //    body enforces exactly-once via a durable already-done marker.
  deps.onFullSuccess?.(productId, imageDataUrls[0]);
  return { status: 'created', productId };
}

// ── pure UI decision (testable without a renderer) ──────────────────────────

export interface ProductCreateUiDecision {
  /** Close the create modal as a full success. */
  closeModal: boolean;
  /** What the UI should tell the user. */
  message: 'created' | 'media_incomplete' | 'product_save_failed';
  /** The product id to keep for a retry (null when nothing to retain). */
  retainProductId: string | null;
  /** Whether the create button should offer a retry rather than a fresh add. */
  offerRetry: boolean;
}

/**
 * The modal's close/keep-open decision. A full success closes; anything else
 * keeps the modal open, tells the user their product was saved but the images
 * are not fully in place, and retains the id so the next submit is a retry —
 * never a second product.
 */
export function decideProductCreateUi(r: ProductCreateResult): ProductCreateUiDecision {
  if (r.status === 'created') {
    return { closeModal: true, message: 'created', retainProductId: null, offerRetry: false };
  }
  if (r.status === 'media_incomplete') {
    // The product IS saved; only the images are incomplete → keep the id and
    // let the user retry the image import without re-creating the product.
    return { closeModal: false, message: 'media_incomplete', retainProductId: r.productId, offerRetry: true };
  }
  // product_save_failed: the row is not durable. Retry may reuse the id safely
  // (it re-inserts), but the UI must not pretend anything was created.
  return { closeModal: false, message: 'product_save_failed', retainProductId: r.productId, offerRetry: true };
}

function asMessage(e: unknown): string {
  const c = (e as { code?: string; message?: string })?.code ?? (e as { message?: string })?.message;
  return c ?? String(e);
}

// ── pure helpers (shared with the store, testable in isolation) ─────────────

/** Two ordered image lists are the SAME create intent iff identical in length
 *  and element-for-element (data URLs compared verbatim). */
export function sameImageIntent(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether the AI embedding side effect should START now. Eventual at-most-once:
 * only when AI is configured, an image exists, it was NOT already computed
 * durably (the `products.image_embedding` marker), and no compute is already
 * in flight this session. A partial create never reaches full success, so this
 * is only ever consulted on a completed create/retry.
 */
export function shouldStartEmbedding(opts: {
  configured: boolean;
  hasImage: boolean;
  alreadyComputed: boolean;
  inFlight: boolean;
}): boolean {
  return opts.configured && opts.hasImage && !opts.alreadyComputed && !opts.inFlight;
}
