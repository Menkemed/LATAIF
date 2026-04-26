import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { PreciousMetal, MetalStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getSetting } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface MetalStore {
  metals: PreciousMetal[];
  loading: boolean;
  loadMetals: () => void;
  getMetal: (id: string) => PreciousMetal | undefined;
  createMetal: (data: Partial<PreciousMetal>) => PreciousMetal;
  updateMetal: (id: string, data: Partial<PreciousMetal>) => void;
  deleteMetal: (id: string) => void;
  getSpotPrice: (metalType: string) => number;
  setSpotPrice: (metalType: string, price: number) => void;
  // Plan §8 #4 — Payment-Tracking für Metall-Verkäufe
  recordMetalPayment: (metalId: string, amount: number, method: 'cash' | 'bank' | 'card', date?: string, note?: string) => void;
  getMetalPayments: (metalId: string) => Array<{ id: string; amount: number; method: string; paidAt: string; note?: string }>;
}

function rowToMetal(row: Record<string, unknown>): PreciousMetal {
  return {
    id: row.id as string,
    metalType: row.metal_type as PreciousMetal['metalType'],
    karat: row.karat as PreciousMetal['karat'] | undefined,
    weightGrams: row.weight_grams as number,
    description: row.description as string | undefined,
    purchasePricePerGram: row.purchase_price_per_gram as number | undefined,
    purchaseTotal: row.purchase_total as number | undefined,
    spotPriceAtPurchase: row.spot_price_at_purchase as number | undefined,
    currentSpotPrice: row.current_spot_price as number | undefined,
    meltValue: row.melt_value as number | undefined,
    salePrice: row.sale_price as number | undefined,
    status: (row.status as MetalStatus) || 'in_stock',
    paidAmount: (row.paid_amount as number) || 0,
    paymentStatus: (row.payment_status as 'UNPAID' | 'PARTIALLY_PAID' | 'PAID') || 'UNPAID',
    supplierName: row.supplier_name as string | undefined,
    customerId: row.customer_id as string | undefined,
    notes: row.notes as string | undefined,
    images: JSON.parse((row.images as string) || '[]'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useMetalStore = create<MetalStore>((set, get) => ({
  metals: [],
  loading: false,

  loadMetals: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM precious_metals WHERE branch_id = ? ORDER BY updated_at DESC', [branchId]);
      set({ metals: rows.map(rowToMetal), loading: false });
    } catch {
      set({ metals: [], loading: false });
    }
  },

  getMetal: (id) => get().metals.find(m => m.id === id),

  getSpotPrice: (metalType: string): number => {
    const val = getSetting(`spot_price.${metalType}`, '0');
    return parseFloat(val) || 0;
  },

  setSpotPrice: (metalType: string, price: number) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }
    const key = `spot_price.${metalType}`;
    db.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES (?, ?, ?, 'metals', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [branchId, key, String(price), now]
    );
    saveDatabase();
  },

  createMetal: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();

    const metal: PreciousMetal = {
      id,
      metalType: data.metalType || 'gold',
      karat: data.karat,
      weightGrams: data.weightGrams || 0,
      description: data.description,
      purchasePricePerGram: data.purchasePricePerGram,
      purchaseTotal: data.purchaseTotal,
      spotPriceAtPurchase: data.spotPriceAtPurchase,
      currentSpotPrice: data.currentSpotPrice,
      meltValue: data.meltValue,
      salePrice: data.salePrice,
      status: data.status || 'in_stock',
      supplierName: data.supplierName,
      customerId: data.customerId,
      notes: data.notes,
      images: data.images || [],
      createdAt: now,
      updatedAt: now,
    };

    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    db.run(
      `INSERT INTO precious_metals (id, branch_id, metal_type, karat, weight_grams, description,
        purchase_price_per_gram, purchase_total, spot_price_at_purchase, current_spot_price,
        melt_value, sale_price, status, supplier_name, customer_id, notes, images,
        created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, metal.metalType, metal.karat || null, metal.weightGrams,
       metal.description || null, metal.purchasePricePerGram || null,
       metal.purchaseTotal || null, metal.spotPriceAtPurchase || null,
       metal.currentSpotPrice || null, metal.meltValue || null,
       metal.salePrice || null, metal.status,
       metal.supplierName || null, metal.customerId || null,
       metal.notes || null, JSON.stringify(metal.images), now, now,
       (() => { try { return currentUserId(); } catch { return null; } })()]
    );

    saveDatabase();
    trackInsert('precious_metals', id, { metalType: metal.metalType, karat: metal.karat, weightGrams: metal.weightGrams });
    get().loadMetals();
    return metal;
  },

  updateMetal: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      metalType: 'metal_type',
      karat: 'karat',
      weightGrams: 'weight_grams',
      description: 'description',
      purchasePricePerGram: 'purchase_price_per_gram',
      purchaseTotal: 'purchase_total',
      spotPriceAtPurchase: 'spot_price_at_purchase',
      currentSpotPrice: 'current_spot_price',
      meltValue: 'melt_value',
      salePrice: 'sale_price',
      status: 'status',
      supplierName: 'supplier_name',
      customerId: 'customer_id',
      notes: 'notes',
    };

    for (const [key, val] of Object.entries(data)) {
      const col = fieldMap[key];
      if (col) { fields.push(`${col} = ?`); values.push(val); }
    }
    if (data.images) { fields.push('images = ?'); values.push(JSON.stringify(data.images)); }

    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE precious_metals SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('precious_metals', id, data);
    get().loadMetals();
  },

  deleteMetal: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM precious_metals WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('precious_metals', id);
    get().loadMetals();
  },

  // Plan §8 #4 — Metal-Zahlungen. Akkumuliert, leitet paymentStatus + bei voll+status=in_stock auf 'sold' ab.
  recordMetalPayment: (metalId, amount, method, date, note) => {
    if (amount <= 0) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    const m = get().getMetal(metalId);
    if (!m) return;

    const paymentId = uuid();
    db.run(
      `INSERT INTO metal_payments (id, metal_id, amount, method, paid_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, metalId, amount, method, date || now.split('T')[0], note || null, now]
    );

    const target = m.salePrice || 0;
    const newPaid = target > 0 ? Math.min(target, (m.paidAmount || 0) + amount) : (m.paidAmount || 0) + amount;
    const newStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' =
      target > 0 && newPaid >= target - 0.001 ? 'PAID'
      : newPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
    const newMetalStatus: MetalStatus = newStatus === 'PAID' && m.status === 'in_stock' ? 'sold' : m.status;

    db.run(
      `UPDATE precious_metals SET paid_amount = ?, payment_status = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newPaid, newStatus, newMetalStatus, now, metalId]
    );
    saveDatabase();
    trackInsert('metal_payments', paymentId, { metalId, amount, method });
    trackUpdate('precious_metals', metalId, { paidAmount: newPaid, paymentStatus: newStatus, status: newMetalStatus });
    get().loadMetals();
  },

  getMetalPayments: (metalId) => {
    try {
      const rows = query(
        `SELECT id, amount, method, paid_at, note FROM metal_payments WHERE metal_id = ? ORDER BY paid_at ASC`,
        [metalId]
      );
      return rows.map(r => ({
        id: r.id as string,
        amount: (r.amount as number) || 0,
        method: r.method as string,
        paidAt: r.paid_at as string,
        note: (r.note as string) || undefined,
      }));
    } catch { return []; }
  },
}));
