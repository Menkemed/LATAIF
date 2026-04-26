// ═══════════════════════════════════════════════════════════
// LATAIF — Supplier Store (Plan §Supplier)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Supplier } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface SupplierCredit {
  id: string;
  supplierId: string;
  amount: number;
  usedAmount: number;
  remaining: number;
  status: 'OPEN' | 'USED' | 'EXPIRED';
  sourceReturnId?: string;
  sourcePurchaseId?: string;
  note?: string;
  createdAt: string;
}

interface SupplierStore {
  suppliers: Supplier[];
  loading: boolean;
  loadSuppliers: () => void;
  getSupplier: (id: string) => Supplier | undefined;
  createSupplier: (data: Partial<Supplier>) => Supplier;
  updateSupplier: (id: string, data: Partial<Supplier>) => void;
  deleteSupplier: (id: string) => void;
  getLedger: (id: string) => { totalPurchases: number; totalPaid: number; outstandingBalance: number; creditBalance: number };
  // Plan §8 #3 — explizite Credit-Records aus supplier_credits Tabelle
  getOpenCredits: (supplierId: string) => SupplierCredit[];
  applyCreditToPurchase: (creditId: string, purchaseId: string, amount: number) => void;
}

function rowToSupplier(row: Record<string, unknown>): Supplier {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    name: row.name as string,
    phone: row.phone as string | undefined,
    email: row.email as string | undefined,
    address: row.address as string | undefined,
    notes: row.notes as string | undefined,
    active: Number(row.active) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export const useSupplierStore = create<SupplierStore>((set, get) => ({
  suppliers: [],
  loading: false,

  loadSuppliers: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM suppliers WHERE branch_id = ? ORDER BY name', [branchId]);
      const list = rows.map(rowToSupplier);
      // Enrich with ledger numbers
      for (const s of list) {
        Object.assign(s, get().getLedger(s.id));
      }
      set({ suppliers: list, loading: false });
    } catch { set({ suppliers: [], loading: false }); }
  },

  getSupplier: (id) => get().suppliers.find(s => s.id === id),

  createSupplier: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    db.run(
      `INSERT INTO suppliers (id, branch_id, name, phone, email, address, notes, active, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, branchId, data.name || '', data.phone || null, data.email || null,
       data.address || null, data.notes || null, now, now, userId]
    );
    saveDatabase();
    trackInsert('suppliers', id, { name: data.name });
    get().loadSuppliers();
    return get().getSupplier(id)!;
  },

  updateSupplier: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', phone: 'phone', email: 'email', address: 'address', notes: 'notes',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('suppliers', id, data);
    get().loadSuppliers();
  },

  deleteSupplier: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM suppliers WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('suppliers', id);
    get().loadSuppliers();
  },

  // Plan §Supplier §4: computed from purchases/payments.
  // Plan §Purchase Returns §8: creditBalance = Summe aller Returns mit refund_method='credit'
  // MINUS verbrauchte Credit-Payments auf Purchases.
  getLedger: (id) => {
    try {
      const p = query(
        `SELECT COALESCE(SUM(total_amount),0) as t, COALESCE(SUM(paid_amount),0) as paid
         FROM purchases WHERE supplier_id = ? AND status != 'CANCELLED'`,
        [id]
      );
      const totalPurchases = (p[0]?.t as number) || 0;
      const totalPaid = (p[0]?.paid as number) || 0;

      const credit = query(
        `SELECT
           COALESCE((SELECT SUM(refund_amount) FROM purchase_returns
             WHERE supplier_id = ? AND refund_method = 'credit' AND status IN ('CONFIRMED','COMPLETED')), 0) AS earned,
           COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp
             JOIN purchases pu ON pu.id = pp.purchase_id
             WHERE pu.supplier_id = ? AND pp.method = 'credit'), 0) AS used`,
        [id, id]
      );
      const earned = (credit[0]?.earned as number) || 0;
      const used = (credit[0]?.used as number) || 0;
      const creditBalance = Math.max(0, earned - used);

      return {
        totalPurchases,
        totalPaid,
        outstandingBalance: totalPurchases - totalPaid,
        creditBalance,
      };
    } catch {
      return { totalPurchases: 0, totalPaid: 0, outstandingBalance: 0, creditBalance: 0 };
    }
  },

  // Plan §8 #3 — offene Credit-Records aus supplier_credits (neu eingeführte Tabelle).
  getOpenCredits: (supplierId) => {
    try {
      const rows = query(
        `SELECT id, supplier_id, source_return_id, source_purchase_id, amount, used_amount, status, note, created_at
           FROM supplier_credits WHERE supplier_id = ? AND status = 'OPEN' ORDER BY created_at DESC`,
        [supplierId]
      );
      return rows.map(r => {
        const amount = (r.amount as number) || 0;
        const used = (r.used_amount as number) || 0;
        return {
          id: r.id as string,
          supplierId: r.supplier_id as string,
          amount,
          usedAmount: used,
          remaining: Math.max(0, amount - used),
          status: (r.status as 'OPEN' | 'USED' | 'EXPIRED') || 'OPEN',
          sourceReturnId: (r.source_return_id as string) || undefined,
          sourcePurchaseId: (r.source_purchase_id as string) || undefined,
          note: (r.note as string) || undefined,
          createdAt: r.created_at as string,
        };
      });
    } catch { return []; }
  },

  // Plan §8 #3 — Credit auf einen Purchase anwenden: used_amount erhöhen, Purchase als bezahlt verbuchen.
  applyCreditToPurchase: (creditId, purchaseId, amount) => {
    if (amount <= 0) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    const cRows = query(`SELECT amount, used_amount FROM supplier_credits WHERE id = ?`, [creditId]);
    if (cRows.length === 0) return;
    const total = (cRows[0].amount as number) || 0;
    const used = (cRows[0].used_amount as number) || 0;
    const available = total - used;
    const apply = Math.min(amount, available);
    if (apply <= 0) return;

    const newUsed = used + apply;
    const newStatus = newUsed >= total - 0.001 ? 'USED' : 'OPEN';
    db.run(
      `UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?`,
      [newUsed, newStatus, creditId]
    );
    // Als Purchase-Payment mit method='credit' verbuchen — existierender Status-Reconcile greift.
    const payId = uuid();
    db.run(
      `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
       VALUES (?, ?, ?, 'credit', ?, ?, 'Applied from supplier credit', ?)`,
      [payId, purchaseId, apply, now.split('T')[0], creditId, now]
    );
    saveDatabase();
    trackUpdate('supplier_credits', creditId, { usedAmount: newUsed, status: newStatus });
    trackInsert('purchase_payments', payId, { purchaseId, amount: apply, method: 'credit' });
  },
}));
