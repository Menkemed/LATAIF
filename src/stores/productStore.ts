import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Product, Category, StockStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { getStockAggregates } from '@/core/lots/lot-queries';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
// pHash entfernt 2026-05-18 — Duplicate-Detection laeuft jetzt nur ueber
// AI-Embedding + Text-Felder (SKU/Serial/Reference). image-hash.ts wird nicht
// mehr importiert.
import { computeImageEmbedding, cosineSimilarity, EMBEDDING_SAME_THRESHOLD, EMBEDDING_SIMILAR_THRESHOLD, isAiConfigured } from '@/core/ai/ai-service';

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
    // Referenz-Check — Produkt darf nicht gelöscht werden wenn in Invoice/Order/Repair etc. verwendet.
    const refs = query(
      `SELECT
         (SELECT COUNT(*) FROM invoice_lines       WHERE product_id = ?) AS invoice_lines,
         (SELECT COUNT(*) FROM consignments        WHERE product_id = ?) AS consignments,
         (SELECT COUNT(*) FROM agent_transfers     WHERE product_id = ?) AS agent_transfers,
         (SELECT COUNT(*) FROM repairs             WHERE product_id = ?) AS repairs,
         (SELECT COUNT(*) FROM sales_return_lines  WHERE product_id = ?) AS return_lines,
         (SELECT COUNT(*) FROM orders              WHERE product_id = ?) AS orders`,
      [id, id, id, id, id, id]
    );
    const r = refs[0] || {};
    const linked = ['invoice_lines', 'consignments', 'agent_transfers', 'repairs', 'return_lines', 'orders']
      .map(k => ({ k, n: Number((r as Record<string, unknown>)[k] || 0) }))
      .filter(x => x.n > 0);
    if (linked.length > 0) {
      const detail = linked.map(x => `${x.n} ${x.k}`).join(', ');
      throw new Error(`Cannot delete product with linked records: ${detail}.`);
    }
    const db = getDatabase();
    db.run('DELETE FROM products WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('products', id);
    get().loadProducts();
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
    const result = new Map<string, number>();
    const ids = productIds && productIds.length > 0 ? productIds : get().products.map(p => p.id);
    if (ids.length === 0) return result;
    // SQL.js mag keine Array-Bindings, also baue WHERE id IN (?, ?, ...) dynamisch.
    // 100er-Batches damit der Query nicht zu lang wird.
    const BATCH = 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const placeholders = slice.map(() => '?').join(', ');
      // Subqueries summieren alle linked-table-Hits pro product. Wenn 0 → kein
      // linked record. Wenn >0 → darf nicht gelöscht werden.
      const sql = `
        SELECT id,
          (SELECT COUNT(*) FROM invoice_lines       WHERE product_id = products.id) +
          (SELECT COUNT(*) FROM consignments        WHERE product_id = products.id) +
          (SELECT COUNT(*) FROM agent_transfers     WHERE product_id = products.id) +
          (SELECT COUNT(*) FROM repairs             WHERE product_id = products.id) +
          (SELECT COUNT(*) FROM sales_return_lines  WHERE product_id = products.id) +
          (SELECT COUNT(*) FROM orders              WHERE product_id = products.id)
          AS linked_count
        FROM products
        WHERE id IN (${placeholders})
      `;
      try {
        const rows = query(sql, slice);
        for (const r of rows) {
          result.set(r.id as string, Number(r.linked_count) || 0);
        }
      } catch (err) {
        console.warn('[getLinkedRecordCounts] batch query failed:', err);
      }
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
    const agg = getStockAggregates(inStock.map(p => p.id));
    let purchaseTotal = 0, saleTotal = 0, count = 0;
    for (const p of inStock) {
      const a = agg.get(p.id);
      if (a) {
        purchaseTotal += a.totalValue;
        count += a.totalQty;
      } else {
        purchaseTotal += p.purchasePrice * (p.quantity || 1);
        count += p.quantity || 1;
      }
      saleTotal += (p.plannedSalePrice || 0) * (p.quantity || 1);
    }
    return { purchaseTotal, saleTotal, count };
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
