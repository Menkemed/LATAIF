import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Product, Category, StockStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

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
    attributes: JSON.parse((row.attributes as string) || '{}'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
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
      set({ products: rows.map(rowToProduct), loading: false });
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
      if (col) { fields.push(`${col} = ?`); values.push(val); }
    }
    if (data.scopeOfDelivery) { fields.push('scope_of_delivery = ?'); values.push(JSON.stringify(data.scopeOfDelivery)); }
    if (data.attributes) { fields.push('attributes = ?'); values.push(JSON.stringify(data.attributes)); }
    if (data.images) { fields.push('images = ?'); values.push(JSON.stringify(data.images)); }

    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('products', id, data);
    eventBus.emit('product.updated', 'product', id, data);
    get().loadProducts();
  },

  deleteProduct: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM products WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('products', id);
    get().loadProducts();
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
    // Stückzahl pro Produkt wird in Berechnung berücksichtigt (User-Wunsch).
    const inStock = get().products.filter(p =>
      (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
    );
    return {
      purchaseTotal: inStock.reduce((s, p) => s + p.purchasePrice * (p.quantity || 1), 0),
      saleTotal: inStock.reduce((s, p) => s + (p.plannedSalePrice || 0) * (p.quantity || 1), 0),
      count: inStock.reduce((s, p) => s + (p.quantity || 1), 0),
    };
  },

  getStockByCategory: () => {
    const { products, categories } = get();
    const inStock = products.filter(p =>
      (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
    );
    return categories.map(cat => {
      const items = inStock.filter(p => p.categoryId === cat.id);
      return {
        categoryId: cat.id,
        name: cat.name,
        color: cat.color,
        count: items.reduce((s, p) => s + (p.quantity || 1), 0),
        value: items.reduce((s, p) => s + p.purchasePrice * (p.quantity || 1), 0),
      };
    }).filter(c => c.count > 0);
  },

  skuExists: (sku) => {
    if (!sku) return false;
    const needle = sku.trim().toUpperCase();
    return get().products.some(p => (p.sku || '').trim().toUpperCase() === needle);
  },

  // Input-Prefix kann z.B. "RLX-SUB", "RLX-SUB-001" oder "RLX-SUB-042" sein.
  // Wir extrahieren den Stamm (ohne letzte Nummer) und finden die nächste freie XXX-Nummer.
  nextAvailableSku: (prefix) => {
    const clean = prefix.trim().toUpperCase();
    // Entferne bestehende 3-stellige Zahl am Ende (z.B. "-001") — nimm nur den Stamm.
    const stem = clean.replace(/-\d{1,4}$/, '');
    const pattern = new RegExp('^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d{1,4})$');
    let maxNum = 0;
    for (const p of get().products) {
      const s = (p.sku || '').trim().toUpperCase();
      const m = s.match(pattern);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    }
    const next = (maxNum + 1).toString().padStart(3, '0');
    return `${stem}-${next}`;
  },
}));
