// ═══════════════════════════════════════════════════════════
// LATAIF — Partner Store (Plan §Partner + §Banking §5 Partner Investment)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Partner, PartnerTransaction, PartnerTransactionType } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface PartnerStore {
  partners: Partner[];
  transactions: PartnerTransaction[];
  loading: boolean;
  loadPartners: () => void;
  loadTransactions: () => void;
  getPartner: (id: string) => Partner | undefined;
  createPartner: (data: Partial<Partner>) => Partner;
  updatePartner: (id: string, data: Partial<Partner>) => void;
  deletePartner: (id: string) => void;
  // Transactions
  recordInvestment: (partnerId: string, amount: number, method: 'cash' | 'bank', date?: string, notes?: string) => PartnerTransaction;
  recordWithdrawal: (partnerId: string, amount: number, method: 'cash' | 'bank', date?: string, notes?: string) => PartnerTransaction;
  recordProfitDistribution: (partnerId: string, amount: number, method: 'cash' | 'bank', date?: string, notes?: string) => PartnerTransaction;
  // Plan §8 #8 — manuell bank-Transaktion als bezahlt markieren.
  markTransactionPaid: (id: string) => void;
  deleteTransaction: (id: string) => void;
  getPartnerLedger: (partnerId: string) => { totalInvested: number; totalWithdrawn: number; totalProfitShare: number; balance: number };
}

function rowToPartner(row: Record<string, unknown>): Partner {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    name: row.name as string,
    phone: row.phone as string | undefined,
    email: row.email as string | undefined,
    sharePercentage: (row.share_percentage as number) || 0,
    active: Number(row.active) === 1,
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToTx(row: Record<string, unknown>): PartnerTransaction {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    partnerId: row.partner_id as string,
    transactionNumber: row.transaction_number as string,
    type: (row.type as PartnerTransactionType) || 'INVESTMENT',
    amount: (row.amount as number) || 0,
    method: (row.method as 'cash' | 'bank') || 'bank',
    transactionDate: row.transaction_date as string,
    notes: row.notes as string | undefined,
    paymentStatus: (row.payment_status as 'PENDING' | 'PAID') || 'PAID',
    paidAtActual: row.paid_at_actual as string | undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const usePartnerStore = create<PartnerStore>((set, get) => ({
  partners: [],
  transactions: [],
  loading: false,

  loadPartners: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM partners WHERE branch_id = ? ORDER BY name', [branchId]);
      const list = rows.map(rowToPartner);
      for (const p of list) {
        Object.assign(p, get().getPartnerLedger(p.id));
      }
      set({ partners: list, loading: false });
    } catch { set({ partners: [], loading: false }); }
  },

  loadTransactions: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM partner_transactions WHERE branch_id = ? ORDER BY transaction_date DESC, created_at DESC', [branchId]);
      set({ transactions: rows.map(rowToTx) });
    } catch { set({ transactions: [] }); }
  },

  getPartner: (id) => get().partners.find(p => p.id === id),

  createPartner: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    db.run(
      `INSERT INTO partners (id, branch_id, name, phone, email, share_percentage, active, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [id, branchId, data.name || '', data.phone || null, data.email || null,
       data.sharePercentage || 0, data.notes || null, now, now, userId]
    );
    saveDatabase();
    trackInsert('partners', id, { name: data.name });
    get().loadPartners();
    return get().getPartner(id)!;
  },

  updatePartner: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', phone: 'phone', email: 'email',
      sharePercentage: 'share_percentage', notes: 'notes',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE partners SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('partners', id, data);
    get().loadPartners();
  },

  deletePartner: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM partners WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('partners', id);
    get().loadPartners();
  },

  recordInvestment: (partnerId, amount, method, date, notes) => {
    return recordTx(partnerId, 'INVESTMENT', amount, method, date, notes, get);
  },

  recordWithdrawal: (partnerId, amount, method, date, notes) => {
    return recordTx(partnerId, 'WITHDRAWAL', amount, method, date, notes, get);
  },

  recordProfitDistribution: (partnerId, amount, method, date, notes) => {
    return recordTx(partnerId, 'PROFIT_DISTRIBUTION', amount, method, date, notes, get);
  },

  // Plan §8 #8 — PENDING bank-Transaktion als bestätigt bezahlt markieren.
  markTransactionPaid: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      `UPDATE partner_transactions SET payment_status = 'PAID', paid_at_actual = ? WHERE id = ?`,
      [now, id]
    );
    saveDatabase();
    trackInsert('partner_transactions', id, { paymentStatus: 'PAID', paidAt: now });
    get().loadTransactions();
  },

  deleteTransaction: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM partner_transactions WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('partner_transactions', id);
    get().loadTransactions();
    get().loadPartners();
  },

  getPartnerLedger: (partnerId) => {
    try {
      const rows = query(
        `SELECT type, COALESCE(SUM(amount),0) as total FROM partner_transactions WHERE partner_id = ? GROUP BY type`,
        [partnerId]
      );
      let totalInvested = 0, totalWithdrawn = 0, totalProfitShare = 0;
      for (const r of rows) {
        const amt = (r.total as number) || 0;
        if (r.type === 'INVESTMENT') totalInvested = amt;
        else if (r.type === 'WITHDRAWAL') totalWithdrawn = amt;
        else if (r.type === 'PROFIT_DISTRIBUTION') totalProfitShare = amt;
      }
      return {
        totalInvested, totalWithdrawn, totalProfitShare,
        balance: totalInvested + totalProfitShare - totalWithdrawn,
      };
    } catch {
      return { totalInvested: 0, totalWithdrawn: 0, totalProfitShare: 0, balance: 0 };
    }
  },
}));

// Helper — records a partner transaction with correct prefix
function recordTx(
  partnerId: string,
  type: PartnerTransactionType,
  amount: number,
  method: 'cash' | 'bank',
  date: string | undefined,
  notes: string | undefined,
  get: () => PartnerStore
): PartnerTransaction {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = uuid();
  let branchId: string, userId: string;
  try { branchId = currentBranchId(); userId = currentUserId(); }
  catch { branchId = 'branch-main'; userId = 'user-owner'; }

  // Plan §Settings §B: PST (Partner Investment), PWD (Partner Withdrawal)
  const prefix = type === 'INVESTMENT' ? 'PST' : type === 'WITHDRAWAL' ? 'PWD' : 'PWD';
  const txNumber = getNextDocumentNumber(prefix);

  // Plan §8 #8 — Payment-Status: cash = direkt PAID (Geld fließt sofort),
  // bank = PENDING bis zur Bestätigung (z.B. Überweisung kann scheitern).
  const paymentStatus: 'PENDING' | 'PAID' = method === 'cash' ? 'PAID' : 'PENDING';
  const paidAt = paymentStatus === 'PAID' ? now : null;

  db.run(
    `INSERT INTO partner_transactions (id, branch_id, partner_id, transaction_number, type, amount, method,
      transaction_date, notes, payment_status, paid_at_actual, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, branchId, partnerId, txNumber, type, amount, method, date || now.split('T')[0],
     notes || null, paymentStatus, paidAt, now, userId]
  );
  saveDatabase();
  trackInsert('partner_transactions', id, { partnerId, type, amount, method, paymentStatus });
  get().loadTransactions();
  get().loadPartners();
  return get().transactions.find(t => t.id === id)!;
}
