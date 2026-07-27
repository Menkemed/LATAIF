import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Product, Category, StockStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { getStockAggregates, computeStockValuation } from '@/core/lots/lot-queries';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
// pHash entfernt 2026-05-18 — Duplicate-Detection laeuft jetzt nur ueber
// AI-Embedding + Text-Felder (SKU/Serial/Reference). image-hash.ts wird nicht
// mehr importiert.
import { computeImageEmbedding, cosineSimilarity, EMBEDDING_SAME_THRESHOLD, EMBEDDING_SIMILAR_THRESHOLD, isAiConfigured } from '@/core/ai/ai-service';
import { saveDatabaseDurably } from '@/core/db/database';
import { createProductWithDurableMedia, sameImageIntent, shouldStartEmbedding, type ProductCreateResult, type MediaSource } from '@/core/media/product-media-create';
import { createRequestId, canonicalRequestHash, decodeDataUrl, ProductMediaCutoverService, type DecodedLegacyImage } from '@/core/media/product-media-cutover';
import { getStockMediaOrchestrator, type IngestAndFinalizeInput, type EditScope, type EditNewImageInput } from '@/core/media/orchestrator';
import { buildEditPlanEnvelope } from '@/core/media/product-media-edit';
import type { ProductEditIntent } from '@/core/media/coordinator';
import type { PreparedMediaItem } from '@/core/media/mobile-upload-drain';
import { canEditImages, draftFromSrcs, buildImageEditInputs, diffProductText, editHasChanges, type ResolverStatus } from '@/core/media/product-edit-draft';
import { ProductMediaResolver } from '@/core/media/product-media-resolver';
import { validateEphemeralImage, selectDurablePrimary, validateDurableBytes, isObjectUrl, type AiImageSource } from '@/core/media/ai-image-source';
import { runStartupMediaRecovery, type CompletedProductScope } from '@/core/media/startup-recovery';
import { findProductsNeedingEmbedding } from '@/core/media/embedding-reconcile';
import { TauriMediaGateway } from '@/core/media/gateway';
import { isSyncConfigured } from '@/core/sync/sync-service';

// ── SSOT: alle Tabellen die ein Produkt via product_id referenzieren ──
// Hat EINE davon einen Treffer, gilt das Produkt als "verknuepft" und darf
// NICHT geloescht werden (sonst verwaisen Rechnungen/Einkaeufe/Lots etc.).
// Wichtig: stock_lots zaehlt mit, blockt aber nie ein sauber manuell angelegtes
// Produkt — Lots entstehen ausschliesslich aus Purchase/Consignment/Return.
// production_inputs + production_outputs teilen sich das Label "Production".
const PRODUCT_LINK_TABLES: { table: string; label: string }[] = [
  { table: 'invoice_lines', label: 'Invoice' },
  { table: 'purchase_lines', label: 'Purchase' },
  { table: 'offer_lines', label: 'Offer' },
  { table: 'consignments', label: 'Consignment' },
  { table: 'agent_transfers', label: 'Agent Transfer' },
  { table: 'repairs', label: 'Repair' },
  { table: 'sales_return_lines', label: 'Sales Return' },
  { table: 'orders', label: 'Order' },
  { table: 'order_lines', label: 'Order' },
  { table: 'production_inputs', label: 'Production' },
  { table: 'production_outputs', label: 'Production' },
  { table: 'stock_lots', label: 'Stock Lot' },
];

export interface ProductLink { label: string; count: number; }

// MOBILE-04B2A2 — the durable cross-DB source binding written ATOMICALLY with the product in the
// single create checkpoint. It is the sql.js-side resume anchor for the mobile upload drain worker:
// a crash after the product is durable but before the Rust job is marked `ready` is reconciled by
// finding this receipt for the same (tenant, branch, uploadEventId) → the SAME product → re-mark
// ready, never a second product. `entity_id`/`product_id` are the pinned id; `payload_hash` is the
// Rust job's frozen payload hash. Local, non-synced.
export interface MobileUploadReceiptIntent {
  uploadEventId: string;
  payloadHash: string;
  authenticatedUserId: string;
  canonicalProductMetadataHash: string;
  preparedManifestHash: string;
}

// MEDIA-04A-3B2B-R1 — retry intent + embedding guards (module-scoped, per JS
// session). `retryCreateManifests` freezes the ORIGINAL create intent for a
// product that partially failed, so a retry uses the exact same ordered image
// list; a retry that supplies a DIFFERENT list is a typed conflict, never a
// silent overwrite. `embeddingInFlight` dedups the async embedding within a
// session; durable at-most-once is additionally keyed on the existing
// `products.image_embedding` column (no schema change).
const retryCreateManifests = new Map<string, { images: string[] }>();
const embeddingInFlight = new Set<string>();
// MEDIA-04A-3B2C2 — retain the frozen edit batch id per product so a retry
// reuses the SAME durable batch (no duplicate links/changelog/audit).
const retryEditBatches = new Map<string, string>();

export type EditProductResult =
  | { status: 'edited'; batchId: string }
  | { status: 'edit_incomplete'; errorCode: string; batchId?: string }
  | { status: 'edit_conflict'; errorCode: string }
  | { status: 'blocked'; errorCode: string }
  /** Legacy product cut over durably — the UI must reload + retry the edit. */
  | { status: 'cutover_reload' };

/**
 * MEDIA-04A-3B2B-R3 — trigger startup media recovery (idempotent, once per DB
 * epoch). Called fire-and-forget after DB init / reload. Any create-batch left
 * half-published is completed here; products that thereby become complete are
 * fed to the embedding guard exactly once.
 *
 * Fail-safe: never throws, never blocks the app. The resolver keeps showing a
 * `pending` skeleton (never a partial gallery) until a pass succeeds.
 */
// ── MEDIA-04A-3B2C3 — safe AI-identifier image input ────────────────────────
export type AiImageInputResult =
  | { ok: true; dataUrl: string; source: AiImageSource }
  | { ok: false; error: string; blocking: boolean };

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function decodeBase64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Resolve the safe AI-identifier image input for a call site (3B2C3):
 *   • a fresh `data:` URL   → ephemeral_new (frozen by content hash, never
 *     persisted, never a blob: URL);
 *   • a blob: URL / no URL for an EXISTING product → durable_primary read
 *     scope-exact + verified through the resolver (active primary, master
 *     raster, hash integrity) — never products.images, never a thumbnail.
 * Fail-closed: `blocking:true` means DO NOT call the provider (object URL,
 * pending/conflict/integrity, unsupported MIME); `blocking:false` means "no
 * usable image" so the caller may still run a text-only identification.
 * In-memory only — no temp file, no base64 in SQLite, no image-content logging.
 */
export async function resolveAiImageInput(productId: string | undefined, formImage0: string | undefined): Promise<AiImageInputResult> {
  try {
    // A freshly picked, not-yet-persisted image: fully validate it (syntax,
    // base64 decode, MIME↔magic-byte match, byte + pixel bounds, no SVG/active
    // content) and freeze the hash from the DECODED bytes.
    if (formImage0 && formImage0.startsWith('data:')) {
      const val = await validateEphemeralImage(formImage0, `ai:${productId ?? 'new'}`, { decodeBase64: decodeBase64ToBytes, hashBytes: sha256HexOfBytes });
      return val.ok ? { ok: true, dataUrl: formImage0, source: val.source } : { ok: false, error: val.error, blocking: val.error !== 'MEDIA_AI_NO_IMAGE' };
    }
    // An existing product's verified active primary (blob: display URL or none).
    if (!productId) return { ok: false, error: 'MEDIA_AI_NO_IMAGE', blocking: false };
    let branchId: string; try { branchId = currentBranchId(); } catch { branchId = ''; }
    const tRows = branchId ? query('SELECT tenant_id FROM branches WHERE id = ?', [branchId]) : [];
    const tenantId = tRows.length > 0 ? (tRows[0].tenant_id as string | null) : null;
    if (!branchId || !tenantId) return { ok: false, error: 'MEDIA_AI_SCOPE_REQUIRED', blocking: true };
    const resolver = new ProductMediaResolver({ dbProvider: () => getDatabase() as never, gateway: new TauriMediaGateway(), tenantId, branchId });
    const resolution = await resolver.resolvePrimaryProductMedia(productId);
    const items = resolution.kind === 'media' ? resolution.items.map((i) => ({ mediaId: i.mediaId, mimeType: i.mimeType, sortOrder: i.sortOrder, isPrimary: i.isPrimary })) : [];
    const primRes = resolution.kind === 'media' ? { kind: 'media' as const, items } : { kind: resolution.kind } as { kind: 'legacy' | 'none' | 'pending' | 'conflict' | 'integrity_error' | 'legacy_format_error' };
    const sel = selectDurablePrimary({ tenantId, branchId, productId }, primRes);
    if (!sel.ok) {
      const nonBlocking = sel.error === 'MEDIA_AI_NO_PRIMARY' || sel.error === 'MEDIA_AI_NOT_MIGRATED';
      // If the display URL was an object URL we STILL never fall back to it.
      void isObjectUrl;
      return { ok: false, error: sel.error, blocking: !nonBlocking };
    }
    // Build the provider data: URL from the VERIFIED primary bytes, in memory.
    const prim = resolution.kind === 'media' ? resolution.items.find((i) => i.isPrimary && i.sortOrder === 0) : undefined;
    if (!prim) return { ok: false, error: 'MEDIA_AI_NO_PRIMARY', blocking: false };
    // Final content-shape check on the VERIFIED primary bytes (main raster, not
    // a thumbnail) before building the provider data: URL from those bytes.
    const dv = validateDurableBytes(prim.bytes, prim.mimeType);
    if (!dv.ok) return { ok: false, error: dv.error, blocking: true };
    let bin = ''; for (let i = 0; i < prim.bytes.length; i++) bin += String.fromCharCode(prim.bytes[i]);
    const dataUrl = `data:${prim.mimeType};base64,${btoa(bin)}`;
    return { ok: true, dataUrl, source: sel.source };
  } catch (e) {
    return { ok: false, error: (e as { message?: string })?.message ?? 'MEDIA_AI_INPUT_FAILED', blocking: true };
  }
}

export async function triggerStartupMediaRecovery(): Promise<void> {
  try {
    const { currentDbEpoch } = await import('@/core/db/database');
    const orch = await getStockMediaOrchestrator();
    await runStartupMediaRecovery({
      currentEpoch: () => currentDbEpoch(),
      recover: () => orch.recoverPendingStockMedia(),
      onCompletedProducts: (scopes) => {
        useProductStore.getState().loadProducts();
        for (const s of scopes) void embedRecoveredProduct(s);
      },
      log: (m, e) => console.warn('[media] ' + m, e),
    });
  } catch (e) {
    console.warn('[media] startup recovery trigger failed', e);
  }
  // Durable, scope-exact reconciliation (3B2B-R4). Runs on EVERY init/reload,
  // even when the once-per-epoch recovery above was skipped: it catches
  // products whose batch completed in a prior session (recovery ran before the
  // store hook existed) or that crashed after media-ready but before embedding.
  // The embedding guard makes it at-most-once per product, so re-running is safe.
  void reconcileMediaEmbeddings();
}

/**
 * MEDIA-04A-3B2B-R4 — start the embedding for every product with a complete,
 * cutover-visible media gallery that still has no `image_embedding`. Read-only
 * DB scan; each candidate goes through the existing at-most-once embedding guard
 * (durable marker + in-flight set). Never throws.
 */
export async function reconcileMediaEmbeddings(): Promise<void> {
  try {
    if (!isAiConfigured()) return;
    const scopes = findProductsNeedingEmbedding(getDatabase() as unknown as { exec: (s: string, p?: unknown[]) => Array<{ columns: string[]; values: unknown[][] }> });
    for (const s of scopes) void embedRecoveredProduct(s);
  } catch (e) {
    console.warn('[media] embedding reconciliation failed', e);
  }
}

/**
 * Best-effort AI embedding for a product whose batch completed only at startup
 * recovery (its base64 was never persisted — no base64 in SQLite by design).
 * Reads the primary rendition back from the media store, then runs the EXISTING
 * embedding guard: fires at most once (durable `image_embedding` marker +
 * in-flight set). This is the honest bound — at-most-once per product; no
 * stronger exactly-once claim across a mid-compute crash.
 */
async function embedRecoveredProduct(scope: CompletedProductScope): Promise<void> {
  try {
    if (!isAiConfigured()) return;
    const pid = scope.productId;
    const already = query('SELECT image_embedding FROM products WHERE id = ?', [pid]);
    const embVal = already.length > 0 ? already[0].image_embedding : null;
    if (!shouldStartEmbedding({ configured: true, hasImage: true, alreadyComputed: embVal != null && String(embVal).length > 0, inFlight: embeddingInFlight.has(pid) })) return;
    // Resolve the primary rendition (hash + mime + extension) from the DB.
    const rows = query(
      `SELECT g.stored_blob_hash AS hash, g.extension AS ext, g.mime_type AS mime
         FROM media_links l
         JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id AND o.deleted_at IS NULL
         JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id AND b.blob_status = 'present'
         JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
        WHERE l.tenant_id = ? AND l.branch_id = ? AND l.entity_type = 'product' AND l.entity_id = ?
          AND l.media_role = ? AND l.is_primary = 1 AND l.deleted_at IS NULL LIMIT 1`,
      [scope.tenantId, scope.branchId, pid, scope.role],
    );
    if (rows.length === 0) return;
    const hash = String(rows[0].hash); const ext = String(rows[0].ext); const mime = String(rows[0].mime);
    embeddingInFlight.add(pid);
    try {
      const read = await new TauriMediaGateway().readVerifiedMedia({ tenantScope: scope.tenantId, hash, extension: ext });
      let bin = '';
      for (let i = 0; i < read.bytes.length; i++) bin += String.fromCharCode(read.bytes[i]);
      const dataUrl = `data:${mime};base64,${btoa(bin)}`;
      const { description, embedding } = await computeImageEmbedding(dataUrl);
      getDatabase().run('UPDATE products SET image_description = ?, image_embedding = ? WHERE id = ?', [description, JSON.stringify(embedding), pid]);
      saveDatabase();
      trackUpdate('products', pid, { imageDescription: description, imageEmbedding: embedding });
      useProductStore.getState().loadProducts();
    } finally {
      embeddingInFlight.delete(pid);
    }
  } catch (e) {
    console.warn('[media] recovered-product embedding failed', e);
  }
}

/**
 * Liefert pro productId die Liste der verknuepften Record-Typen (nur die mit
 * count > 0). Leeres Array = nirgends referenziert = loeschbar. Labels werden
 * dedupliziert (z.B. production_inputs + production_outputs → 1x "Production").
 * Batched (100er) damit der IN(...)-Query bei vielen IDs nicht zu lang wird.
 */
function queryProductLinks(ids: string[]): Map<string, ProductLink[]> {
  const result = new Map<string, ProductLink[]>();
  if (ids.length === 0) return result;
  const cols = PRODUCT_LINK_TABLES
    .map((t, i) => `(SELECT COUNT(*) FROM ${t.table} WHERE product_id = products.id) AS c${i}`)
    .join(', ');
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const placeholders = slice.map(() => '?').join(', ');
    const sql = `SELECT id, ${cols} FROM products WHERE id IN (${placeholders})`;
    try {
      const rows = query(sql, slice);
      for (const r of rows) {
        const rec = r as Record<string, unknown>;
        const links: ProductLink[] = [];
        PRODUCT_LINK_TABLES.forEach((t, idx) => {
          const n = Number(rec[`c${idx}`] || 0);
          if (n <= 0) return;
          const existing = links.find(l => l.label === t.label);
          if (existing) existing.count += n;
          else links.push({ label: t.label, count: n });
        });
        result.set(r.id as string, links);
      }
    } catch (err) {
      console.warn('[queryProductLinks] batch query failed:', err);
    }
  }
  return result;
}

interface ProductStore {
  products: Product[];
  categories: Category[];
  loading: boolean;
  searchQuery: string;
  filterCategory: string;
  filterStatus: StockStatus | '';
  setSearchQuery: (q: string) => void;
  setFilterCategory: (c: string) => void;
  setFilterStatus: (s: StockStatus | '') => void;
  loadCategories: () => void;
  loadProducts: () => void;
  getProduct: (id: string) => Product | undefined;
  getCategory: (id: string) => Category | undefined;
  createProduct: (data: Partial<Product>) => Product;
  /**
   * MEDIA-04A-3B2B — create a new product whose photos live in the durable
   * media system, not in `products.images`. Strict order: product row
   * (images='[]') → durable save → ordered media append → success only when all
   * media is durable. Retry with the returned productId reuses the same product
   * (no duplicate). Used by the Collection create flow; every other caller keeps
   * the synchronous `createProduct`.
   */
  createProductWithMedia: (data: Partial<Product>, retryProductId?: string, receiptIntent?: MobileUploadReceiptIntent, source?: MediaSource) => Promise<ProductCreateResult>;
  editProductWithMedia: (
    id: string,
    data: Partial<Product>,
    editImages: { srcs: string[]; resolved: Array<{ url: string; mediaId: string }>; status: ResolverStatus },
    retryEditId?: string,
  ) => Promise<EditProductResult>;
  updateProduct: (id: string, data: Partial<Product>) => void;
  deleteProduct: (id: string) => void;
  createCategory: (data: Partial<Category>) => Category;
  updateCategory: (id: string, data: Partial<Category>) => void;
  getStockValue: () => { purchaseTotal: number; saleTotal: number; count: number };
  getStockByCategory: () => { categoryId: string; name: string; color: string; count: number; value: number }[];
  // Plan §Product: SKU-Kollisions-Check. Nimmt einen Prefix ("RLX-SUB") und findet nächste freie Nummer.
  // Gibt vollen SKU zurück, z.B. "RLX-SUB-042". Vermeidet Duplikate über alle Produkte (auch sold).
  nextAvailableSku: (prefix: string) => string;
  skuExists: (sku: string) => boolean;
  /** True wenn sku bereits in einem anderen Produkt (ungleich excludeId) existiert. Case-insensitiv, getrimmt. */
  isSkuTaken: (sku: string, excludeProductId?: string) => boolean;
  /**
   * Findet wahrscheinliche Duplikate zu einem geplanten neuen Produkt.
   * Score-basiert: SKU/Serial-Treffer ≥100 (sicher), Brand+Name+Ref ≥60 (wahrscheinlich),
   * Brand-only / Gold-Gewicht-Match ≥40 (ähnlich). Werte <40 werden gefiltert.
   * Sortiert absteigend nach Score, max 5 Treffer.
   */
  findPossibleDuplicates: (
    candidate: Partial<Product>,
    excludeProductId?: string,
    options?: { mode?: 'all' | 'image-only' },
  ) => Array<{ product: Product; score: number; reasons: string[]; matchClass: 'STRONG' | 'POSSIBLE' }>;
  /**
   * Plan §Sync-Duplicate: vereinigt zwei Produkte. Übernimmt qty von Source ins
   * Target, kopiert Source-Bild falls Target noch keins hat, löscht Source.
   * Wird vom SyncDuplicateGuard aufgerufen, wenn der User ein phone-uploaded
   * Item als Duplikat bestätigt — statt Neu-Anlage wird die Menge addiert.
   */
  mergeIntoExisting: (sourceProductId: string, targetProductId: string) => void;
  /**
   * Plan §Duplicate-Groups: Liefert pro productId die Summe aller verknüpften
   * Datensätze (invoice_lines + consignments + agent_transfers + repairs +
   * sales_return_lines + orders). Nutzt 1 SQL-Query mit Subqueries für N IDs.
   * Wird vom Cluster-Algorithmus für die Master-Selection genutzt: Produkte mit
   * linked records gewinnen +1000 Punkte (siehe spec).
   */
  getLinkedRecordCounts: (productIds?: string[]) => Map<string, number>;
  /**
   * Liefert pro productId die verknuepften Record-Typen (label + count), nur
   * die mit count > 0. Leeres Array = loeschbar. Genutzt von der Collection-
   * Loeschfunktion: linked Produkte werden mit Hinweis blockiert, saubere
   * Produkte (leeres Array) sind nach Bestaetigung loeschbar.
   */
  getProductLinks: (productIds?: string[]) => Map<string, ProductLink[]>;
  /**
   * Bulk-Loeschung. Re-prueft jede ID gegen ALLE Link-Tabellen; verknuepfte
   * werden uebersprungen (blocked), nur saubere geloescht. Gibt deleted-IDs +
   * blocked-Liste (mit Grund) zurueck. Speichert + reloaded nur wenn etwas
   * geloescht wurde.
   */
  deleteProducts: (ids: string[]) => { deleted: string[]; blocked: { id: string; reason: string }[] };
}

function rowToCategory(row: Record<string, unknown>): Category {
  return {
    id: row.id as string,
    name: row.name as string,
    icon: (row.icon as string) || 'Package',
    color: (row.color as string) || '#0F0F10',
    attributes: JSON.parse((row.attributes as string) || '[]'),
    scopeOptions: JSON.parse((row.scope_options as string) || '[]'),
    conditionOptions: JSON.parse((row.condition_options as string) || '[]'),
    active: row.active === 1,
    sortOrder: (row.sort_order as number) || 0,
    createdAt: row.created_at as string,
  };
}

// 2026-05-18 — AI-Learning: liefert die letzten N user-Korrekturen +
// Bestaetigungen pro Brand/Kategorie als Few-Shot-Text fuer den naechsten
// Identify. Wird von SyncDuplicateGuard.runAutoIdentify und NewProductModal
// aufgerufen.
//
// Format:
//   NEGATIVE Examples (Corrections): "AI said X, user corrected to Y"
//   POSITIVE Examples (Confirmations): "Confirmed by user: Brand+Name+Ref=Z"
export function getRecentCorrectionsAsPrompt(brand?: string, categoryId?: string, limit = 5): string {
  const sections: string[] = [];

  // Negative Examples
  try {
    const rows = query(
      `SELECT brand, name, sku, ai_corrections
         FROM products
        WHERE ai_corrections IS NOT NULL
          AND TRIM(ai_corrections) != ''
          AND TRIM(ai_corrections) != '[]'
          AND (
            ? = '' OR brand = ?
            OR ? = '' OR category_id = ?
          )
        ORDER BY updated_at DESC
        LIMIT ?`,
      [brand || '', brand || '', categoryId || '', categoryId || '', limit]
    );
    const lines: string[] = [];
    for (const r of rows) {
      try {
        const corrections = JSON.parse(r.ai_corrections as string) as Array<{ field: string; aiSaid: unknown; userChanged: unknown }>;
        if (!Array.isArray(corrections) || corrections.length === 0) continue;
        const itemLabel = `${r.brand} ${r.name || ''}`.trim() || '(item)';
        for (const c of corrections) {
          const aiVal = c.aiSaid === null || c.aiSaid === undefined ? '(empty)' : String(c.aiSaid);
          const userVal = c.userChanged === null || c.userChanged === undefined ? '(empty)' : String(c.userChanged);
          lines.push(`  - "${itemLabel}" — AI said ${c.field}=${aiVal}, user corrected to ${c.field}=${userVal}`);
        }
      } catch { /* */ }
    }
    if (lines.length > 0) {
      sections.push(`RECENT USER CORRECTIONS (negative examples — past mistakes; do NOT repeat them):\n${lines.slice(0, 8).join('\n')}`);
    }
  } catch (err) { console.warn('[corrections] failed:', err); }

  // Positive Examples (user-confirmed)
  try {
    const rows = query(
      `SELECT brand, name, sku, attributes
         FROM products
        WHERE ai_confirmed_at IS NOT NULL
          AND TRIM(ai_confirmed_at) != ''
          AND (
            ? = '' OR brand = ?
            OR ? = '' OR category_id = ?
          )
        ORDER BY ai_confirmed_at DESC
        LIMIT ?`,
      [brand || '', brand || '', categoryId || '', categoryId || '', limit]
    );
    const lines: string[] = [];
    for (const r of rows) {
      const refAttr = (() => {
        try {
          const a = JSON.parse((r.attributes as string) || '{}') as Record<string, unknown>;
          return (a.reference_number || a.reference || a.serial_number) as string | undefined;
        } catch { return undefined; }
      })();
      const refLabel = refAttr ? ` ref=${refAttr}` : '';
      lines.push(`  - "${r.brand} ${r.name || ''}".trim()" CONFIRMED CORRECT by user (sku=${r.sku || '?'}${refLabel})`);
    }
    if (lines.length > 0) {
      sections.push(`CONFIRMED CORRECT IDENTIFICATIONS (positive examples — when you see similar items, use these as known-good references):\n${lines.slice(0, 8).join('\n')}`);
    }
  } catch (err) { console.warn('[confirmations] failed:', err); }

  if (sections.length === 0) return '';
  return `\n\n${sections.join('\n\n')}\n`;
}

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    categoryId: row.category_id as string,
    brand: row.brand as string,
    name: row.name as string,
    sku: row.sku as string | undefined,
    quantity: Math.max(1, (row.quantity as number) || 1),
    condition: (row.condition as string) || '',
    scopeOfDelivery: JSON.parse((row.scope_of_delivery as string) || '[]'),
    storageLocation: row.storage_location as string | undefined,
    purchaseDate: row.purchase_date as string | undefined,
    purchasePrice: row.purchase_price as number,
    purchaseCurrency: (row.purchase_currency as Product['purchaseCurrency']) || 'BHD',
    plannedSalePrice: row.planned_sale_price as number | undefined,
    minSalePrice: row.min_sale_price as number | undefined,
    maxSalePrice: row.max_sale_price as number | undefined,
    lastOfferPrice: row.last_offer_price as number | undefined,
    lastSalePrice: row.last_sale_price as number | undefined,
    stockStatus: (row.stock_status as StockStatus) || 'in_stock',
    taxScheme: (row.tax_scheme as Product['taxScheme']) || 'MARGIN',
    expectedMargin: row.expected_margin as number | undefined,
    daysInStock: row.days_in_stock as number | undefined,
    supplierName: row.supplier_name as string | undefined,
    purchaseSource: row.purchase_source as string | undefined,
    paidFrom: (row.paid_from as 'cash' | 'bank' | null) ?? null,
    sourceType: (row.source_type as 'OWN' | 'CONSIGNMENT' | 'AGENT') || 'OWN',
    notes: row.notes as string | undefined,
    images: JSON.parse((row.images as string) || '[]'),
    imageHash: (row.image_hash as string) || undefined,
    imageDescription: (row.image_description as string) || undefined,
    imageEmbedding: (() => {
      const raw = row.image_embedding as string | null | undefined;
      if (!raw) return undefined;
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) && v.length > 0 ? v as number[] : undefined;
      } catch { return undefined; }
    })(),
    aiIdentifiedSnapshot: (row.ai_identified_snapshot as string) || undefined,
    aiCorrections: (row.ai_corrections as string) || undefined,
    aiConfirmedAt: (row.ai_confirmed_at as string) || undefined,
    attributes: JSON.parse((row.attributes as string) || '{}'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

// 2026-05-18: Lazy-Backfill jetzt direkt auf Embeddings — pHash entfernt.
// Funktion bleibt als Einstiegspunkt damit der Aufrufer (loadProducts) keine
// Aenderung braucht; sie delegiert direkt an backfillEmbeddings.
function backfillImageHashes(products: Product[]): void {
  backfillEmbeddings(products);
}

// Plan §AI-Embedding — Lazy-Backfill (Vision + Embedding API-Calls).
// 1 Item pro Sekunde damit OpenAI-Rate-Limits nicht greifen und der Cashflow
// (~$0.001/Item) für den User transparent bleibt. Nur wenn API-Key gesetzt ist.
let embeddingBackfillRunning = false;
function backfillEmbeddings(products: Product[]): void {
  if (embeddingBackfillRunning) return;
  if (!isAiConfigured()) return;
  const todo = products.filter(p => p.images.length > 0 && (!p.imageEmbedding || p.imageEmbedding.length === 0));
  if (todo.length === 0) return;
  embeddingBackfillRunning = true;
  let i = 0;
  async function processNext() {
    if (i >= todo.length) {
      try { saveDatabase(); } catch { /* */ }
      embeddingBackfillRunning = false;
      useProductStore.getState().loadProducts();
      return;
    }
    const p = todo[i++];
    try {
      const { description, embedding } = await computeImageEmbedding(p.images[0]);
      try {
        getDatabase().run(
          'UPDATE products SET image_description = ?, image_embedding = ? WHERE id = ?',
          [description, JSON.stringify(embedding), p.id],
        );
        trackUpdate('products', p.id, { imageDescription: description, imageEmbedding: embedding });
        p.imageDescription = description;
        p.imageEmbedding = embedding;
      } catch (err) { console.warn('[embedding-backfill] persist failed:', err); }
    } catch (err) {
      console.warn('[embedding-backfill] compute failed for', p.id, err);
      // Bei Quota-Fehler oder Netz-Problem stoppen — nicht weiterloopen.
      const msg = err instanceof Error ? err.message : String(err);
      if (/quota|429|401|403/i.test(msg)) {
        console.warn('[embedding-backfill] giving up due to:', msg);
        embeddingBackfillRunning = false;
        return;
      }
    }
    // 1s Pause zwischen API-Calls.
    setTimeout(processNext, 1000);
  }
  setTimeout(processNext, 500);
}

function parseResults(results: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  if (results.length === 0) return [];
  const cols = results[0].columns;
  return results[0].values.map(row => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

export const useProductStore = create<ProductStore>((set, get) => ({
  products: [],
  categories: [],
  loading: false,
  searchQuery: '',
  filterCategory: '',
  filterStatus: '',

  setSearchQuery: (q) => set({ searchQuery: q }),
  setFilterCategory: (c) => set({ filterCategory: c }),
  setFilterStatus: (s) => set({ filterStatus: s }),

  loadCategories: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM categories WHERE branch_id = ? AND active = 1 ORDER BY sort_order', [branchId]);
      set({ categories: rows.map(rowToCategory) });
    } catch {
      // Not authenticated yet, load without branch filter
      const rows = parseResults(getDatabase().exec('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order'));
      set({ categories: rows.map(rowToCategory) });
    }
  },

  loadProducts: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM products WHERE branch_id = ? ORDER BY updated_at DESC', [branchId]);
      const products = rows.map(rowToProduct);
      set({ products, loading: false });
      // Lazy-Backfill für pHash auf bestehende Produkte mit Bild aber ohne Hash.
      // Im Hintergrund, in Batches von 5, damit die Main-Thread nicht stockt.
      backfillImageHashes(products);
    } catch {
      set({ products: [], loading: false });
    }
  },

  getProduct: (id) => get().products.find(p => p.id === id),
  getCategory: (id) => get().categories.find(c => c.id === id),

  createProduct: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const margin = data.plannedSalePrice ? data.plannedSalePrice - (data.purchasePrice || 0) : undefined;

    const product: Product = {
      id,
      categoryId: data.categoryId || '',
      brand: data.brand || '',
      name: data.name || '',
      sku: data.sku,
      quantity: Math.max(1, data.quantity || 1),
      condition: data.condition || '',
      scopeOfDelivery: data.scopeOfDelivery || [],
      storageLocation: data.storageLocation,
      purchaseDate: data.purchaseDate || now.split('T')[0],
      purchasePrice: data.purchasePrice || 0,
      purchaseCurrency: data.purchaseCurrency || 'BHD',
      plannedSalePrice: data.plannedSalePrice,
      minSalePrice: data.minSalePrice,
      maxSalePrice: data.maxSalePrice,
      stockStatus: (data.stockStatus as StockStatus) || 'in_stock',
      taxScheme: data.taxScheme || 'MARGIN',
      expectedMargin: margin,
      daysInStock: 0,
      supplierName: data.supplierName,
      purchaseSource: data.purchaseSource,
      paidFrom: data.paidFrom ?? null,
      sourceType: data.sourceType || 'OWN',
      notes: data.notes,
      images: data.images || [],
      attributes: data.attributes || {},
      createdAt: now,
      updatedAt: now,
    };

    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    db.run(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery,
        storage_location, purchase_date, purchase_price, purchase_currency, planned_sale_price,
        min_sale_price, max_sale_price,
        stock_status, tax_scheme, expected_margin, days_in_stock, supplier_name, purchase_source, paid_from, source_type, notes, images, attributes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, product.categoryId, product.brand, product.name, product.sku || null, product.quantity,
       product.condition, JSON.stringify(product.scopeOfDelivery),
       product.storageLocation || null, product.purchaseDate, product.purchasePrice,
       product.purchaseCurrency, product.plannedSalePrice || null,
       product.minSalePrice || null, product.maxSalePrice || null,
       product.stockStatus, product.taxScheme, margin || null,
       product.supplierName || null, product.purchaseSource || null, product.paidFrom || null, product.sourceType || 'OWN', product.notes || null,
       JSON.stringify(product.images), JSON.stringify(product.attributes), now, now,
       (() => { try { return currentUserId(); } catch { return null; } })()]
    );

    saveDatabase();
    trackInsert('products', id, { brand: product.brand, name: product.name, categoryId: product.categoryId, purchasePrice: product.purchasePrice });
    eventBus.emit('product.created', 'product', id, { brand: product.brand, name: product.name });
    get().loadProducts();
    // 2026-05-18: pHash entfernt — nur noch AI-Embedding wird async im Hintergrund
    // berechnet (2-5s, ~$0.001/Item). Ohne API-Key wird nichts mehr berechnet;
    // Duplicate-Detection greift dann nur auf SKU/Serial/Brand+Reference zurueck.
    if (product.images.length > 0) {
      const imgUrl = product.images[0];
      if (isAiConfigured()) {
        computeImageEmbedding(imgUrl)
          .then(({ description, embedding }) => {
            try {
              getDatabase().run(
                'UPDATE products SET image_description = ?, image_embedding = ? WHERE id = ?',
                [description, JSON.stringify(embedding), id],
              );
              saveDatabase();
              trackUpdate('products', id, { imageDescription: description, imageEmbedding: embedding });
              get().loadProducts();
            } catch (err) { console.warn('[productStore] embedding persist failed:', err); }
          })
          .catch(err => { console.warn('[productStore] embedding compute failed:', err); });
      }
    }
    return product;
  },

  createProductWithMedia: async (data, retryProductId, receiptIntent, source) => {
    // Stable id across retries — reusing it is what keeps a retry from creating
    // a second product.
    const id = retryProductId ?? uuid();

    // Authorised scope only: branch from the session, tenant = the DB-authoritative
    // owner of that branch. No default — reject if either is missing.
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = ''; }
    const tenantRows = branchId ? query('SELECT tenant_id FROM branches WHERE id = ?', [branchId]) : [];
    const tenantId = tenantRows.length > 0 ? (tenantRows[0].tenant_id as string | null) : null;
    if (!branchId || !tenantId) {
      return { status: 'product_save_failed', productId: id, errorCode: 'MEDIA_CREATE_SCOPE_REQUIRED' };
    }

    const now = new Date().toISOString();
    // MOBILE-04B2A2 — the media source is a discriminated union: the UI supplies `data_urls`; the
    // mobile handoff supplies opaque `prepared_media` descriptors (no sentinel/data-URL/decode).
    const src: MediaSource = source ?? { kind: 'data_urls', images: Array.isArray(data.images) ? data.images : [] };
    const usingPrepared = src.kind === 'prepared_media';
    // The frozen original intent (if this product partially failed before). The
    // create core rejects a retry whose image list differs from it.
    const frozen = retryProductId ? retryCreateManifests.get(retryProductId) : undefined;
    void sameImageIntent; // intent comparison lives in the create core

    const orchestrator = await getStockMediaOrchestrator();
    const role = 'stock_image';
    // Durable batch grouping — deterministic from the (upload-bound) product id, stable across
    // retries, frozen into every slot's intent for restart recovery.
    const batchId = `create:${tenantId}:${branchId}:${id}:${role}`;

    const result = await createProductWithDurableMedia(id, src, {
      expectedImages: frozen?.images,
      productExists: (pid) => query('SELECT 1 FROM products WHERE id = ?', [pid]).length > 0,
      insertProductRow: (pid) => {
        const margin = data.plannedSalePrice ? data.plannedSalePrice - (data.purchasePrice || 0) : undefined;
        // Identical column set to createProduct, but images is ALWAYS '[]' — no
        // base64/data URL is ever written to products.images on this path.
        getDatabase().run(
          `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery,
            storage_location, purchase_date, purchase_price, purchase_currency, planned_sale_price,
            min_sale_price, max_sale_price,
            stock_status, tax_scheme, expected_margin, days_in_stock, supplier_name, purchase_source, paid_from, source_type, notes, images, attributes, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
          [pid, branchId, data.categoryId || '', data.brand || '', data.name || '', data.sku || null, Math.max(1, data.quantity || 1),
           data.condition || '', JSON.stringify(data.scopeOfDelivery || []),
           data.storageLocation || null, data.purchaseDate || now.split('T')[0], data.purchasePrice || 0,
           data.purchaseCurrency || 'BHD', data.plannedSalePrice || null,
           data.minSalePrice || null, data.maxSalePrice || null,
           (data.stockStatus as StockStatus) || 'in_stock', data.taxScheme || 'MARGIN', margin || null,
           data.supplierName || null, data.purchaseSource || null, data.paidFrom || null, data.sourceType || 'OWN', data.notes || null,
           JSON.stringify(data.attributes || {}), now, now,
           (() => { try { return currentUserId(); } catch { return null; } })()],
        );
      },
      saveDurably: () => saveDatabaseDurably(),
      // Roll back a non-durable insert AND its in-memory batch job rows, so a
      // failed batch checkpoint leaves no ghost product and no orphan ingest
      // job in the in-memory DB (nothing was durable to begin with).
      rollbackProductRow: (pid) => {
        try {
          getDatabase().run('DELETE FROM products WHERE id = ?', [pid]);
          getDatabase().run(
            `DELETE FROM media_ingest_jobs WHERE requested_entity_id = ? AND requested_role = ? AND tenant_id = ? AND branch_id = ?`,
            [pid, role, tenantId, branchId],
          );
          // R5: also undo the in-memory durable insert record (sync + audit).
          // The save never landed, so these rows are non-durable too — dropping
          // them leaves NO stranded changelog/audit for a product that will not
          // exist. Keyed by (table, record) — the fresh insert wrote at most one.
          getDatabase().run(`DELETE FROM sync_changelog WHERE table_name = 'products' AND record_id = ?`, [pid]);
          getDatabase().run(`DELETE FROM audit_log WHERE entity_type = 'products' AND entity_id = ?`, [pid]);
          // MOBILE-04B2A2 — undo the non-durable source receipt too (nothing landed).
          if (receiptIntent) {
            getDatabase().run(
              `DELETE FROM mobile_upload_receipts WHERE tenant_id = ? AND branch_id = ? AND authenticated_user_id = ? AND upload_event_id = ?`,
              [tenantId, branchId, receiptIntent.authenticatedUserId, receiptIntent.uploadEventId],
            );
          }
        } catch { /* nothing durable to undo */ }
      },
      // Build one durable-batch item per image: computed content hash, fixed
      // slot 0..N-1, and the shared batch grouping (batchId + expectedCount).
      buildBatchItems: async (pid, images: DecodedLegacyImage[]) => {
        const items: IngestAndFinalizeInput[] = [];
        for (let i = 0; i < images.length; i++) {
          const bytes = images[i].bytes;
          items.push({
            tenantId, branchId, entityType: 'product', entityId: pid,
            scopeKind: 'branch', role,
            ingestRequestId: createRequestId(tenantId, branchId, pid, role, i),
            requestHash: await canonicalRequestHash(bytes, tenantId),
            isPrimary: i === 0, sortOrder: i,
            imageBytes: bytes,
            batch: { batchId, expectedCount: images.length },
          });
        }
        return items;
      },
      // MOBILE-04B2A2 — prepared descriptors → batch items with NO bytes/sentinel. The Rust-derived
      // ingestRequestId (= prepareRequestId, upload-bound) is used verbatim; the orchestrator
      // re-verifies the prepared result against the media journal on register+commit.
      buildPreparedBatchItems: async (pid, prepared: PreparedMediaItem[]) => prepared.map((p): IngestAndFinalizeInput => ({
        tenantId, branchId, entityType: 'product', entityId: pid, scopeKind: 'branch', role,
        ingestRequestId: p.ingestRequestId, requestHash: p.prepared.request_hash,
        isPrimary: p.isPrimary, sortOrder: p.slot,
        prepared: p.prepared,
        batch: { batchId, expectedCount: prepared.length },
      })),
      prepareAndRegisterBatch: (items) => orchestrator.prepareAndRegisterBatch(items as IngestAndFinalizeInput[]),
      finalizeBatch: (items) => orchestrator.finalizeBatch(items as IngestAndFinalizeInput[]),
      // DURABLE insert side effects — written in-memory BEFORE the batch
      // checkpoint so they persist atomically with the product row + intents.
      // trackInsert is non-idempotent (auto-id changelog/audit rows), so it is
      // driven only on a fresh insert; a retry never re-enters this path.
      recordDurableInsert: (pid) => {
        trackInsert('products', pid, { brand: data.brand, name: data.name, categoryId: data.categoryId, purchasePrice: data.purchasePrice });
        // MOBILE-04B2A2 — bind the mobile upload source to THIS product in the SAME durable
        // checkpoint (fresh insert only). This receipt is the resume anchor: it makes "the product
        // for uploadEventId already exists" a durable fact, so a crash before the Rust `ready`
        // never causes a second product. Not synced. entity_id == product_id == the pinned id.
        if (receiptIntent) {
          getDatabase().run(
            `INSERT OR IGNORE INTO mobile_upload_receipts
               (tenant_id, branch_id, authenticated_user_id, upload_event_id, payload_hash, entity_id, create_batch_id, product_id, canonical_product_metadata_hash, prepared_manifest_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [tenantId, branchId, receiptIntent.authenticatedUserId, receiptIntent.uploadEventId, receiptIntent.payloadHash, pid, batchId, pid, receiptIntent.canonicalProductMetadataHash, receiptIntent.preparedManifestHash, now],
          );
        }
      },
      // TRANSIENT side effects only — rebuilt by the normal load after a
      // restart, so a crash between the checkpoint and here loses nothing durable.
      onProductInserted: (pid) => {
        eventBus.emit('product.created', 'product', pid, { brand: data.brand, name: data.name });
        get().loadProducts();
      },
      onFullSuccess: (pid, firstImageDataUrl) => {
        // Prepared (mobile) mode carries no data URL — the "first image" is a sentinel, so skip the
        // ephemeral-image embedding here (a durable-primary embedding can run via recovery later).
        if (usingPrepared) return;
        // AI embedding — eventual at-most-once. Fires on full success whether
        // this was the fresh create or a completing retry (a partial attempt
        // never reaches here). Guarded so it computes at most once:
        //   • durable marker: only when products.image_embedding is still empty
        //     (survives restarts without a schema change),
        //   • session marker: `embeddingInFlight` dedups the async compute so a
        //     rapid double retry cannot start it twice.
        if (!firstImageDataUrl) return;
        const imgUrl = firstImageDataUrl;
        const already = query('SELECT image_embedding FROM products WHERE id = ?', [pid]);
        const embVal = already.length > 0 ? already[0].image_embedding : null;
        if (!shouldStartEmbedding({
          configured: isAiConfigured(),
          hasImage: true,
          alreadyComputed: embVal != null && String(embVal).length > 0,
          inFlight: embeddingInFlight.has(pid),
        })) return;
        embeddingInFlight.add(pid);
        computeImageEmbedding(imgUrl)
          .then(({ description, embedding }) => {
            try {
              getDatabase().run(
                'UPDATE products SET image_description = ?, image_embedding = ? WHERE id = ?',
                [description, JSON.stringify(embedding), pid],
              );
              saveDatabase();
              trackUpdate('products', pid, { imageDescription: description, imageEmbedding: embedding });
              get().loadProducts();
            } catch (err) { console.warn('[productStore] embedding persist failed:', err); }
          })
          .catch(err => { console.warn('[productStore] embedding compute failed:', err); })
          .finally(() => { embeddingInFlight.delete(pid); });
      },
    });

    // Freeze or clear the retry manifest based on the outcome.
    if (result.status === 'created') {
      retryCreateManifests.delete(id);
    } else {
      // media_incomplete or product_save_failed → keep the ORIGINAL intent for
      // an exact retry (product_save_failed retains it too: the row was rolled
      // back, so a retry safely re-inserts with the same images).
      // Retry-intent freeze only applies to the data_urls path (prepared media is deterministic
      // from its upload identity and reprepared on retry).
      retryCreateManifests.set(id, { images: src.kind === 'data_urls' ? src.images : [] });
    }

    get().loadProducts();
    return result;
  },

  // ── MEDIA-04A-3B2C2 — durable existing-product edit (text + media atomic) ──
  editProductWithMedia: async (id, data, editImages, retryEditId) => {
    // Fail closed: image editing only on a fully-resolved, valid gallery.
    if (!canEditImages(editImages.status)) {
      return { status: 'blocked', errorCode: 'MEDIA_EDIT_GALLERY_NOT_READY' };
    }
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = ''; }
    const tRows = branchId ? query('SELECT tenant_id FROM branches WHERE id = ?', [branchId]) : [];
    const tenantId = tRows.length > 0 ? (tRows[0].tenant_id as string | null) : null;
    if (!branchId || !tenantId) return { status: 'blocked', errorCode: 'MEDIA_EDIT_SCOPE_REQUIRED' };
    const role = 'stock_image';
    const scope: EditScope = { tenantId, scopeKind: 'branch', branchId, entityType: 'product', entityId: id, role };
    const orchestrator = await getStockMediaOrchestrator();

    // Legacy product → cut over FIRST (durable), then ask the UI to reload and
    // retry against the now-materialised media gallery (the draft's object URLs
    // only make sense post-cutover).
    if (editImages.status === 'legacy') {
      try {
        const cutoverDb = () => getDatabase() as unknown as { run(sql: string, params?: unknown[]): void; exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> };
        const cutover = new ProductMediaCutoverService({
          dbProvider: cutoverDb,
          orchestrator,
          commitLegacyCleared: async (pid: string) => { getDatabase().run(`UPDATE products SET images = '[]' WHERE id = ?`, [pid]); await saveDatabaseDurably(); },
          tenantId, branchId, role,
        });
        await cutover.ensureProductMediaCutover(id);
      } catch (e) {
        return { status: 'edit_incomplete', errorCode: (e as { message?: string })?.message ?? 'MEDIA_EDIT_CUTOVER_FAILED' };
      }
      get().loadProducts();
      return { status: 'cutover_reload' };
    }

    // Build stable draft items from the flat srcs + the resolved (url→mediaId).
    const draftRes = draftFromSrcs(editImages.srcs, editImages.resolved);
    if (!draftRes.ok) return { status: 'blocked', errorCode: draftRes.error };
    const baselineMediaIds = editImages.resolved.map((r) => r.mediaId);
    const imgRes = buildImageEditInputs(draftRes.value, baselineMediaIds);
    if (!imgRes.ok) return { status: 'blocked', errorCode: imgRes.error };
    const { newImages, galleryChanged } = imgRes.value;

    // Product text diff (only changed whitelisted columns).
    const cur = query('SELECT * FROM products WHERE id = ?', [id])[0] as Record<string, unknown> | undefined;
    const cols: Array<{ col: string; baseline: string | number | null; target: string | number | null }> = [];
    const map: Record<string, string> = {
      categoryId: 'category_id', brand: 'brand', name: 'name', sku: 'sku', quantity: 'quantity', condition: 'condition',
      storageLocation: 'storage_location', purchaseDate: 'purchase_date', purchasePrice: 'purchase_price',
      plannedSalePrice: 'planned_sale_price', minSalePrice: 'min_sale_price', maxSalePrice: 'max_sale_price',
      stockStatus: 'stock_status', taxScheme: 'tax_scheme', expectedMargin: 'expected_margin',
      supplierName: 'supplier_name', purchaseSource: 'purchase_source', paidFrom: 'paid_from', sourceType: 'source_type', notes: 'notes',
    };
    const dd = data as Record<string, unknown>;
    for (const [k, c] of Object.entries(map)) {
      if (!(k in dd)) continue;
      const target = (dd[k] ?? null) as string | number | null;
      cols.push({ col: c, baseline: (cur?.[c] ?? null) as string | number | null, target });
    }
    if (data.scopeOfDelivery !== undefined) cols.push({ col: 'scope_of_delivery', baseline: (cur?.scope_of_delivery ?? null) as string, target: JSON.stringify(data.scopeOfDelivery || []) });
    if (data.attributes !== undefined) cols.push({ col: 'attributes', baseline: (cur?.attributes ?? null) as string, target: JSON.stringify(data.attributes || {}) });
    const aiCorr = (dd.aiCorrections ?? undefined) as string | undefined;
    if (aiCorr !== undefined) cols.push({ col: 'ai_corrections', baseline: (cur?.ai_corrections ?? null) as string, target: aiCorr });
    const textDiff = diffProductText(cols);

    if (!editHasChanges(textDiff.set, galleryChanged)) return { status: 'edited', batchId: '' };

    const productEdit: ProductEditIntent = {
      set: textDiff.set, baseline: textDiff.baseline,
      invalidateImageDerived: galleryChanged,
      withSync: isSyncConfigured(),
      audit: { module: 'Product', changedBy: (() => { try { return currentUserId(); } catch { return null; } })(), newValueJson: JSON.stringify(Object.fromEntries(textDiff.set)) },
    };

    // Decode new images → prepare inputs (requestId = clientId, content hash).
    const batchId = retryEditId ?? retryEditBatches.get(id) ?? `edit:${tenantId}:${branchId}:${id}:${role}:${uuid()}`;
    retryEditBatches.set(id, batchId);
    let newItems: EditNewImageInput[];
    try {
      newItems = await Promise.all(newImages.map(async (n) => {
        const decoded: DecodedLegacyImage = decodeDataUrl(n.dataUrl);
        return { tenantId, ingestRequestId: n.clientId, requestHash: await canonicalRequestHash(decoded.bytes, tenantId), imageBytes: decoded.bytes };
      }));
    } catch (e) {
      return { status: 'edit_incomplete', errorCode: (e as { message?: string })?.message ?? 'MEDIA_EDIT_DECODE_FAILED', batchId };
    }
    const hashByClient = new Map(newItems.map((n) => [n.ingestRequestId, n.requestHash]));

    try {
      const env = await orchestrator.prepareAndRegisterEdit(scope, newItems, async (baseline, prepared) =>
        buildEditPlanEnvelope({
          batchId, tenantId, branchId, scopeKind: 'branch', entityType: 'product', entityId: id, role,
          baseline,
          desired: draftRes.value.map((it) => {
            if (it.kind === 'existing') return { source: 'keep' as const, mediaId: it.mediaId };
            if (it.kind === 'new') return { source: 'new' as const, requestId: it.clientId, requestHash: hashByClient.get(it.clientId) ?? '' };
            // draftFromSrcs never yields legacy (buildImageEditInputs already
            // refused it) — this is unreachable, kept for exhaustiveness.
            throw new Error('MEDIA_EDIT_LEGACY_NOT_CUTOVER');
          }),
          prepared, productEdit,
        }, async (s) => canonicalRequestHash(new TextEncoder().encode(s), 'edit-plan')));
      await orchestrator.applyEditDurably(env);
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      if (/BASELINE_CHANGED|PLAN_CONFLICT/.test(msg)) return { status: 'edit_conflict', errorCode: msg };
      return { status: 'edit_incomplete', errorCode: msg, batchId };
    }

    retryEditBatches.delete(id);
    eventBus.emit('product.updated', 'product', id, data);
    get().loadProducts();
    return { status: 'edited', batchId };
  },

  updateProduct: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      categoryId: 'category_id',
      brand: 'brand', name: 'name', sku: 'sku', quantity: 'quantity', condition: 'condition',
      storageLocation: 'storage_location', purchaseDate: 'purchase_date',
      purchasePrice: 'purchase_price', plannedSalePrice: 'planned_sale_price',
      minSalePrice: 'min_sale_price', maxSalePrice: 'max_sale_price',
      lastOfferPrice: 'last_offer_price', lastSalePrice: 'last_sale_price',
      stockStatus: 'stock_status', taxScheme: 'tax_scheme',
      expectedMargin: 'expected_margin', supplierName: 'supplier_name',
      purchaseSource: 'purchase_source', paidFrom: 'paid_from', sourceType: 'source_type', notes: 'notes',
    };

    for (const [key, val] of Object.entries(data)) {
      const col = fieldMap[key];
      if (col) { fields.push(`${col} = ?`); values.push(val ?? null); }
    }
    if (data.scopeOfDelivery) { fields.push('scope_of_delivery = ?'); values.push(JSON.stringify(data.scopeOfDelivery)); }
    if (data.attributes) { fields.push('attributes = ?'); values.push(JSON.stringify(data.attributes)); }
    if (data.images) { fields.push('images = ?'); values.push(JSON.stringify(data.images)); }
    // 2026-05-18 AI-Learning: Snapshot + Corrections durchreichen.
    if ((data as { aiIdentifiedSnapshot?: string }).aiIdentifiedSnapshot !== undefined) {
      fields.push('ai_identified_snapshot = ?');
      values.push((data as { aiIdentifiedSnapshot?: string }).aiIdentifiedSnapshot || null);
    }
    if ((data as { aiCorrections?: string }).aiCorrections !== undefined) {
      fields.push('ai_corrections = ?');
      values.push((data as { aiCorrections?: string }).aiCorrections || null);
    }
    if ((data as { aiConfirmedAt?: string }).aiConfirmedAt !== undefined) {
      fields.push('ai_confirmed_at = ?');
      values.push((data as { aiConfirmedAt?: string }).aiConfirmedAt || null);
    }
    // Caller darf imageHash direkt setzen (z.B. Mobile-Push hat den Hash schon).
    // Sonst lassen wir das Feld leer und der Backfill in loadProducts holt's nach.
    if ((data as { imageHash?: string }).imageHash !== undefined) {
      fields.push('image_hash = ?');
      values.push((data as { imageHash?: string }).imageHash || null);
    } else if (data.images) {
      // Bild geändert → ALLE abgeleiteten Felder (pHash, AI-Description, AI-Embedding)
      // invalidieren. Backfill rechnet sie nach.
      fields.push('image_hash = NULL');
      fields.push('image_description = NULL');
      fields.push('image_embedding = NULL');
    }

    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('products', id, data);
    eventBus.emit('product.updated', 'product', id, data);
    get().loadProducts();
  },

  deleteProduct: (id) => {
    // Referenz-Check ueber ALLE Link-Tabellen (SSOT: PRODUCT_LINK_TABLES).
    // Vorher wurden nur 6 von 12 geprueft → ein Produkt aus einem Purchase
    // (purchase_lines + stock_lots) konnte faelschlich geloescht werden und
    // verwaiste diese Records. Jetzt vollstaendig.
    const links = queryProductLinks([id]).get(id) || [];
    if (links.length > 0) {
      const detail = links.map(l => `${l.count}× ${l.label}`).join(', ');
      throw new Error(`Cannot delete product with linked records: ${detail}.`);
    }
    const db = getDatabase();
    db.run('DELETE FROM products WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('products', id);
    get().loadProducts();
  },

  getProductLinks: (productIds) => {
    const ids = productIds && productIds.length > 0 ? productIds : get().products.map(p => p.id);
    return queryProductLinks(ids);
  },

  deleteProducts: (ids) => {
    const linkMap = queryProductLinks(ids);
    const db = getDatabase();
    const deleted: string[] = [];
    const blocked: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const links = linkMap.get(id) || [];
      if (links.length > 0) {
        blocked.push({ id, reason: links.map(l => l.label).join(', ') });
        continue;
      }
      db.run('DELETE FROM products WHERE id = ?', [id]);
      trackDelete('products', id);
      deleted.push(id);
    }
    if (deleted.length > 0) {
      saveDatabase();
      get().loadProducts();
    }
    return { deleted, blocked };
  },

  mergeIntoExisting: (sourceId, targetId) => {
    const products = get().products;
    const source = products.find(p => p.id === sourceId);
    const target = products.find(p => p.id === targetId);
    if (!source || !target) throw new Error('Source or target product not found');
    if (sourceId === targetId) throw new Error('Cannot merge product into itself');

    const db = getDatabase();
    const now = new Date().toISOString();
    const addQty = Math.max(1, source.quantity || 1);
    const newQty = (target.quantity || 1) + addQty;

    // Source-Bild ins Target übernehmen wenn Target noch keins hat — Foto vom
    // Handy soll nicht verloren gehen, nur weil wir das Source-Item löschen.
    const targetImages = Array.isArray(target.images) ? target.images : [];
    const sourceImages = Array.isArray(source.images) ? source.images : [];
    const mergedImages = targetImages.length === 0 && sourceImages.length > 0
      ? [sourceImages[0]]
      : targetImages;
    const imagesChanged = mergedImages.length !== targetImages.length;

    if (imagesChanged) {
      db.run(`UPDATE products SET quantity = ?, images = ?, updated_at = ? WHERE id = ?`,
        [newQty, JSON.stringify(mergedImages), now, targetId]);
    } else {
      db.run(`UPDATE products SET quantity = ?, updated_at = ? WHERE id = ?`,
        [newQty, now, targetId]);
    }

    db.run('DELETE FROM products WHERE id = ?', [sourceId]);
    saveDatabase();

    // Sync-Tracking: andere Peers sollen Source ebenfalls droppen + Target-Qty sehen.
    trackUpdate('products', targetId, imagesChanged
      ? { quantity: newQty, images: mergedImages }
      : { quantity: newQty });
    trackDelete('products', sourceId);

    eventBus.emit('product.updated', 'product', targetId, { quantity: newQty, mergedFrom: sourceId });
    get().loadProducts();
  },

  getLinkedRecordCounts: (productIds) => {
    // Reuse SSOT-Link-Check (alle 12 Tabellen) und summiere die counts pro
    // Produkt. Vorher waren hier nur 6 Tabellen → Cluster-Master-Selection
    // konnte ein real verknuepftes Produkt als "frei" einstufen.
    const ids = productIds && productIds.length > 0 ? productIds : get().products.map(p => p.id);
    const result = new Map<string, number>();
    const linkMap = queryProductLinks(ids);
    for (const id of ids) {
      const links = linkMap.get(id) || [];
      result.set(id, links.reduce((sum, l) => sum + l.count, 0));
    }
    return result;
  },

  createCategory: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const cat: Category = {
      id, name: data.name || 'New Category', icon: data.icon || 'Package',
      color: data.color || '#0F0F10', attributes: data.attributes || [],
      scopeOptions: data.scopeOptions || [], conditionOptions: data.conditionOptions || [],
      active: true, sortOrder: data.sortOrder || 99, createdAt: now,
    };
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    db.run(
      `INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, branchId, cat.name, cat.icon, cat.color, JSON.stringify(cat.attributes),
       JSON.stringify(cat.scopeOptions), JSON.stringify(cat.conditionOptions), cat.sortOrder, now, now]
    );
    saveDatabase();
    get().loadCategories();
    return cat;
  },

  updateCategory: (id, data) => {
    const db = getDatabase();
    const fields: string[] = [];
    const values: unknown[] = [];
    if (data.name) { fields.push('name = ?'); values.push(data.name); }
    if (data.icon) { fields.push('icon = ?'); values.push(data.icon); }
    if (data.color) { fields.push('color = ?'); values.push(data.color); }
    if (data.attributes) { fields.push('attributes = ?'); values.push(JSON.stringify(data.attributes)); }
    if (data.scopeOptions) { fields.push('scope_options = ?'); values.push(JSON.stringify(data.scopeOptions)); }
    if (data.conditionOptions) { fields.push('condition_options = ?'); values.push(JSON.stringify(data.conditionOptions)); }
    if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }
    if (fields.length === 0) return;
    values.push(id);
    db.run(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    get().loadCategories();
  },

  getStockValue: () => {
    // Plan §Commission §5 + §Dashboard §3.C: "Gesamtwert (nur OWN)".
    // Stock-Lots Phase 7: Bestandswert kommt aus stock_lots (Σ qty_remaining * unit_cost),
    // damit Multi-Lot-Produkte nicht den irreführenden single product.purchase_price benutzen.
    // Fallback auf p.purchase_price * quantity nur wenn das Produkt keine aktiven Lots hat
    // (Legacy-Daten vor Backfill / Produkte ohne Purchase-History).
    const inStock = get().products.filter(p =>
      (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
    );
    // L-18 — zentrale Bewertung via computeStockValuation (Lot, sonst pp×qty).
    const v = computeStockValuation(inStock);
    return { purchaseTotal: v.cost, saleTotal: v.plannedSale, count: v.count };
  },

  getStockByCategory: () => {
    const { products, categories } = get();
    const inStock = products.filter(p =>
      (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
    );
    const agg = getStockAggregates(inStock.map(p => p.id));
    return categories.map(cat => {
      const items = inStock.filter(p => p.categoryId === cat.id);
      let count = 0, value = 0;
      for (const p of items) {
        const a = agg.get(p.id);
        if (a) { count += a.totalQty; value += a.totalValue; }
        else   { count += p.quantity || 1; value += p.purchasePrice * (p.quantity || 1); }
      }
      return { categoryId: cat.id, name: cat.name, color: cat.color, count, value };
    }).filter(c => c.count > 0);
  },

  skuExists: (sku) => {
    if (!sku) return false;
    const needle = sku.trim().toUpperCase();
    return get().products.some(p => (p.sku || '').trim().toUpperCase() === needle);
  },

  isSkuTaken: (sku, excludeProductId) => {
    const t = (sku || '').trim();
    if (!t) return false;
    const needle = t.toUpperCase();
    return get().products.some(p =>
      p.id !== excludeProductId &&
      (p.sku || '').trim().toUpperCase() === needle
    );
  },

  // Universell: Findet die letzte Ziffernfolge am Ende und erhöht sie.
  // Unterstützt jedes Format: "WATCH-0001", "GOLD-0005", "VC-0010",
  // "CA/0007", "CA.0007", "ABC123", oder "ABC" (ohne Ziffern → "ABC-001").
  // Sucht über alle bestehenden SKUs mit demselben Stamm und schlägt
  // max(stem-num) + 1 vor (padded auf Original-Breite).
  nextAvailableSku: (prefix) => {
    const clean = (prefix || '').trim().toUpperCase();
    if (!clean) return '';
    // Match: alles vor trailing-digits + trailing-digits
    const m = clean.match(/^(.*?)(\d+)$/);
    let stem: string;
    let width: number;
    let startNum: number;
    if (m) {
      stem = m[1];           // z.B. "WATCH-", "CA/", "CA.", "ABC"
      startNum = parseInt(m[2], 10);
      width = m[2].length;
    } else {
      stem = clean + '-';    // "ABC" → "ABC-001"
      startNum = 0;
      width = 3;
    }
    // Sammle alle existierenden SKUs + finde max num mit diesem Stamm.
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('^' + escaped + '(\\d+)$');
    const existing = new Set<string>();
    let maxNum = startNum;
    for (const p of get().products) {
      const s = (p.sku || '').trim().toUpperCase();
      if (!s) continue;
      existing.add(s);
      const mm = s.match(pattern);
      if (mm) {
        const n = parseInt(mm[1], 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    }
    // Suggest maxNum + 1; falls Pad-Width überlaufen würde, dynamisch erweitern.
    let next = maxNum + 1;
    let candidate = stem + String(next).padStart(width, '0');
    // Safety: bei Kollision (z.B. Race) iterieren bis frei.
    let safety = 0;
    while (existing.has(candidate.toUpperCase()) && safety < 10000) {
      next++;
      candidate = stem + String(next).padStart(width, '0');
      safety++;
    }
    return candidate;
  },

  // Duplicate Detection (Plan §Product §QuickCapture):
  // Score-System — vergleicht ein Kandidaten-Produkt mit allen existierenden
  // und gibt eine sortierte Liste mit Ähnlichkeitsscore + Begründung zurück.
  // Quellen für Treffer:
  //   • SKU / Serial / Reference exakt           → sehr sicher (100 / 100 / 80)
  //   • Brand + Name exakt                       → wahrscheinlich (60)
  //   • Brand + Name fuzzy (Levenshtein ≤2)      → ähnlich (40)
  //   • Gold: weight (±0.5g) + karat + item_type → ähnlich (50)
  //   • Branded: gleiche model_number            → wahrscheinlich (60)
  //   • Brand-only                               → schwach (10)
  // Threshold zum Anzeigen: ≥40.
  findPossibleDuplicates: (candidate, excludeProductId, options) => {
    // 2026-05-18 — Rewrite: pHash entfernt (User-Spec), strengere Schwellen,
    // STRONG/POSSIBLE Match-Klassen damit Cluster nur via verlaesslicher Signale
    // gebildet werden und schwache Hinweise nicht transitiv zusammenketten.
    //
    // Score-Klassen:
    //   STRONG  (>=80) → sicheres Duplikat → bildet Cluster
    //   POSSIBLE (60-79) → moeglich → nur Hinweis, kein Cluster
    //   alles unter 60 → ignoriert
    //
    // Was zaehlt:
    //   Same SKU                                              → 100 STRONG
    //   Same Serial Number                                    → 100 STRONG
    //   Same Reference Number + Same Brand                    →  90 STRONG
    //   Same Model Number + Same Brand                        →  90 STRONG
    //   AI-Embedding Cosine >= 0.88                            → 100 STRONG
    //   Same Brand + Same Name (exact, beide >= 3 Zeichen)    →  60 POSSIBLE
    //   AI-Embedding Cosine 0.80..0.87                         →  60 POSSIBLE
    //   Gold-Fingerprint (weight+karat+itemType+category)     →  70 POSSIBLE
    //   ───── alles andere wird ignoriert (pHash, Brand-only,
    //         Fuzzy-Name, Reference ohne Brand-Match, ...)
    const mode = options?.mode || 'all';
    const norm = (v: unknown) => String(v ?? '').trim().toUpperCase();
    const cSku = norm(candidate.sku);
    const cBrand = norm(candidate.brand);
    const cName = norm(candidate.name);
    const cCategory = candidate.categoryId || '';
    const cAttrs = candidate.attributes || {};
    const cSerial = norm(cAttrs.serial_number || cAttrs.serialNo);
    const cRef = norm(cAttrs.reference_number || cAttrs.reference || cAttrs.referenceNo);
    const cModelNo = norm(cAttrs.model_number);
    const cWeight = Number(cAttrs.weight) || 0;
    const cKarat = norm(cAttrs.karat);
    const cItemType = norm(cAttrs.item_type);

    const hasSku = !!cSku;
    const hasSerial = !!cSerial;
    const hasRef = !!cRef;
    const hasBrand = !!cBrand;
    const hasName = !!cName && cName.length >= 3;
    const hasModelNo = !!cModelNo;
    const hasGoldFingerprint = cWeight > 0 && !!cKarat && !!cItemType;

    const POSSIBLE_THRESHOLD = 60;
    const STRONG_THRESHOLD = 80;

    const results: Array<{ product: Product; score: number; reasons: string[]; matchClass: 'STRONG' | 'POSSIBLE' }> = [];

    for (const p of get().products) {
      if (p.id === excludeProductId) continue;
      let score = 0;
      const reasons: string[] = [];

      const pSku = norm(p.sku);
      const pBrand = norm(p.brand);
      const pName = norm(p.name);
      const pAttrs = p.attributes || {};
      const pSerial = norm(pAttrs.serial_number || pAttrs.serialNo);
      const pRef = norm(pAttrs.reference_number || pAttrs.reference || pAttrs.referenceNo);
      const pModelNo = norm(pAttrs.model_number);
      const pWeight = Number(pAttrs.weight) || 0;
      const pKarat = norm(pAttrs.karat);
      const pItemType = norm(pAttrs.item_type);

      // Mode 'image-only' = nur AI-Embedding zaehlt. Wird vom SyncDuplicateGuard
      // fuer Phone-Uploads benutzt wo Text-Felder oft Muell sind.
      const all = mode === 'all';

      if (all) {
        // STRONG-Signale (Score >= 80):
        if (hasSku && cSku === pSku) {
          score += 100;
          reasons.push(`Same SKU (${p.sku})`);
        }
        if (hasSerial && cSerial === pSerial) {
          score += 100;
          reasons.push(`Same Serial No (${pAttrs.serial_number || pAttrs.serialNo})`);
        }
        // Reference + Brand zusammen: hochzuverlaessig (Reference allein war
        // frueher 80 Punkte aber falsch positiv weil verschiedene Brands
        // dieselbe "1234" haben koennen).
        if (hasRef && hasBrand && cRef === pRef && cBrand === pBrand) {
          score += 90;
          reasons.push(`Same Brand + Reference (${pAttrs.reference_number || pAttrs.reference || pAttrs.referenceNo})`);
        }
        if (hasModelNo && hasBrand && cModelNo === pModelNo && cBrand === pBrand) {
          score += 90;
          reasons.push(`Same Brand + Model No (${pAttrs.model_number})`);
        }

        // POSSIBLE-Signale (Score 60-79):
        // Brand+Name exact ohne Reference: koennten echte Duplikate sein,
        // koennten aber auch zwei verschiedene Items mit identischem Namen
        // sein (z.B. zwei "Patek Nautilus" ohne Reference angegeben).
        // Erscheint daher nur als Hinweis, nicht als sicherer Cluster.
        if (hasBrand && hasName && cBrand === pBrand && cName === pName) {
          score += 60;
          reasons.push(`Same Brand + Name`);
        }

        // Gold-Fingerprint: weight ±0.5g + same karat + same item_type +
        // same category. Bei Schmuck oft das einzige Identitaets-Signal.
        if (hasGoldFingerprint && pWeight > 0 && pKarat && pItemType
            && cCategory === p.categoryId
            && cKarat === pKarat && cItemType === pItemType
            && Math.abs(cWeight - pWeight) <= 0.5) {
          score += 70;
          reasons.push(`Same ${pAttrs.item_type} · ${pAttrs.weight}g · ${pAttrs.karat}`);
        }
      }

      // AI-Embedding: primaeres Bild-Signal. Robust gegen Winkel/Licht/Crop.
      // pHash wurde explizit entfernt (User-Spec 2026-05-18) — die alte
      // Hamming-Distance-Heuristik produzierte zu viele Falschalarme.
      const cEmb = (candidate as { imageEmbedding?: number[] }).imageEmbedding;
      const pEmb = p.imageEmbedding;
      if (cEmb && cEmb.length > 0 && pEmb && pEmb.length > 0) {
        const sim = cosineSimilarity(cEmb, pEmb);
        if (sim >= EMBEDDING_SAME_THRESHOLD) {
          score += 100;
          reasons.push(`Same item (AI photo match: ${sim.toFixed(2)})`);
        } else if (sim >= EMBEDDING_SIMILAR_THRESHOLD) {
          score += 60;
          reasons.push(`Similar photo (AI: ${sim.toFixed(2)})`);
        }
      }

      if (score >= POSSIBLE_THRESHOLD) {
        const matchClass: 'STRONG' | 'POSSIBLE' = score >= STRONG_THRESHOLD ? 'STRONG' : 'POSSIBLE';
        results.push({ product: p, score, reasons, matchClass });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 8);
  },
}));
