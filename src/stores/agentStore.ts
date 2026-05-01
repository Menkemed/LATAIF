import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Agent, AgentTransfer, AgentTransferStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface AgentStore {
  agents: Agent[];
  transfers: AgentTransfer[];
  loading: boolean;
  loadAgents: () => void;
  loadTransfers: () => void;
  getAgent: (id: string) => Agent | undefined;
  getTransfer: (id: string) => AgentTransfer | undefined;
  createAgent: (data: Partial<Agent>) => Agent;
  updateAgent: (id: string, data: Partial<Agent>) => void;
  deleteAgent: (id: string) => void;
  createTransfer: (data: Partial<AgentTransfer>) => AgentTransfer;
  updateTransfer: (id: string, data: Partial<AgentTransfer>) => void;
  markTransferSold: (id: string, actualPrice: number, buyerInfo?: string) => void;
  markTransferReturned: (id: string) => void;
  // Plan §Agent §4: Teilzahlungen. Wenn amount < settlementAmount → status='partial'.
  markTransferSettled: (id: string, amount?: number, method?: 'cash' | 'bank') => void;
  // Plan §8 #5 — Audit-Trail der Settlement-Zahlungen.
  getSettlementPayments: (transferId: string) => Array<{ id: string; amount: number; method: string; paidAt: string; note?: string }>;
  deleteTransfer: (id: string) => void;
}

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string, name: row.name as string,
    company: row.company as string | undefined,
    phone: row.phone as string | undefined, whatsapp: row.whatsapp as string | undefined,
    email: row.email as string | undefined,
    commissionRate: (row.commission_rate as number) || 10,
    active: row.active === 1, notes: row.notes as string | undefined,
    totalSales: (row.total_sales as number) || 0,
    totalCommission: (row.total_commission as number) || 0,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

function rowToTransfer(row: Record<string, unknown>): AgentTransfer {
  return {
    id: row.id as string, transferNumber: row.transfer_number as string,
    agentId: row.agent_id as string, productId: row.product_id as string,
    agentPrice: (row.agent_price as number) || 0,
    minimumPrice: row.minimum_price as number | undefined,
    commissionRate: (row.commission_rate as number) || 10,
    commissionType: (row.commission_type as 'percent' | 'fixed' | undefined) || 'percent',
    commissionValue: row.commission_value as number | undefined,
    commissionPaidFrom: (row.commission_paid_from as 'cash' | 'bank' | null) ?? null,
    commissionAmount: row.commission_amount as number | undefined,
    status: (row.status as AgentTransferStatus) || 'transferred',
    transferredAt: row.transferred_at as string,
    returnBy: row.return_by as string | undefined,
    soldAt: row.sold_at as string | undefined,
    returnedAt: row.returned_at as string | undefined,
    settledAt: row.settled_at as string | undefined,
    actualSalePrice: row.actual_sale_price as number | undefined,
    buyerInfo: row.buyer_info as string | undefined,
    invoiceId: row.invoice_id as string | undefined,
    settlementAmount: row.settlement_amount as number | undefined,
    settlementPaidAmount: (row.settlement_paid_amount as number | undefined) ?? 0,
    settlementStatus: (row.settlement_status as AgentTransfer['settlementStatus']) || 'pending',
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: [], transfers: [], loading: false,

  loadAgents: () => {
    try {
      const rows = query('SELECT * FROM agents WHERE branch_id = ? ORDER BY name', [currentBranchId()]);
      set({ agents: rows.map(rowToAgent) });
    } catch { set({ agents: [] }); }
  },

  loadTransfers: () => {
    try {
      const rows = query('SELECT * FROM agent_transfers WHERE branch_id = ? ORDER BY created_at DESC', [currentBranchId()]);
      set({ transfers: rows.map(rowToTransfer), loading: false });
    } catch { set({ transfers: [], loading: false }); }
  },

  getAgent: (id) => get().agents.find(a => a.id === id),
  getTransfer: (id) => get().transfers.find(t => t.id === id),

  createAgent: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    db.run(
      `INSERT INTO agents (id, branch_id, name, company, phone, whatsapp, email, commission_rate, active, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, branchId, data.name || '', data.company || null, data.phone || null,
       data.whatsapp || null, data.email || null, data.commissionRate || 10,
       data.notes || null, now, now]
    );
    saveDatabase();
    trackInsert('agents', id, { name: data.name });
    eventBus.emit('agent.created', 'agent', id, { name: data.name });
    get().loadAgents();
    return get().getAgent(id)!;
  },

  updateAgent: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', company: 'company', phone: 'phone', whatsapp: 'whatsapp',
      email: 'email', commissionRate: 'commission_rate', notes: 'notes',
      totalSales: 'total_sales', totalCommission: 'total_commission',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('agents', id, data);
    get().loadAgents();
  },

  deleteAgent: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM agents WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('agents', id);
    get().loadAgents();
  },

  createTransfer: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const transferNumber = getNextNumber('agent_transfers', 'transfer.number_prefix', 'TRF');

    // Update product status
    if (data.productId) {
      // Plan §Product §5: source_type = AGENT während Transfer
      db.run(`UPDATE products SET stock_status = 'with_agent', source_type = 'AGENT', updated_at = ? WHERE id = ?`, [now, data.productId]);
    }

    db.run(
      `INSERT INTO agent_transfers (id, branch_id, transfer_number, agent_id, product_id,
        agent_price, minimum_price, commission_rate, commission_type, commission_value,
        status, transferred_at, return_by,
        notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transferred', ?, ?, ?, ?, ?, ?)`,
      [id, branchId, transferNumber, data.agentId, data.productId,
       data.agentPrice || 0, data.minimumPrice || null, data.commissionRate || 10,
       data.commissionType || 'percent', data.commissionValue ?? null,
       now, data.returnBy || null, data.notes || null, now, now, userId]
    );
    saveDatabase();
    trackInsert('agent_transfers', id, { agentId: data.agentId, productId: data.productId });
    eventBus.emit('agent_transfer.created', 'agent_transfer', id, { agentId: data.agentId, productId: data.productId });
    get().loadTransfers();
    return get().getTransfer(id)!;
  },

  updateTransfer: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      agentPrice: 'agent_price', minimumPrice: 'minimum_price', commissionRate: 'commission_rate',
      commissionType: 'commission_type', commissionValue: 'commission_value',
      commissionPaidFrom: 'commission_paid_from',
      status: 'status', returnBy: 'return_by', actualSalePrice: 'actual_sale_price',
      buyerInfo: 'buyer_info', commissionAmount: 'commission_amount',
      settlementAmount: 'settlement_amount',
      settlementPaidAmount: 'settlement_paid_amount',
      settlementStatus: 'settlement_status',
      notes: 'notes', soldAt: 'sold_at', returnedAt: 'returned_at', settledAt: 'settled_at',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE agent_transfers SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('agent_transfers', id, data);
    get().loadTransfers();
  },

  markTransferSold: (id, actualPrice, buyerInfo) => {
    const transfer = get().getTransfer(id);
    if (!transfer) return;
    const commission = transfer.commissionType === 'fixed'
      ? (transfer.commissionValue || 0)
      : actualPrice * (transfer.commissionRate / 100);
    const settlement = actualPrice - commission;
    const now = new Date().toISOString();

    get().updateTransfer(id, {
      status: 'sold', actualSalePrice: actualPrice, buyerInfo,
      commissionAmount: commission, settlementAmount: settlement, soldAt: now,
    });

    // Update product
    const db = getDatabase();
    // Quantity-aware: dekrementiere Stück; erst wenn Bestand = 0 → stock_status='sold'.
    db.run(
      `UPDATE products SET
         quantity = CASE WHEN COALESCE(quantity,1) > 1 THEN COALESCE(quantity,1) - 1 ELSE 0 END,
         stock_status = CASE WHEN COALESCE(quantity,1) > 1 THEN stock_status ELSE 'sold' END,
         last_sale_price = ?, updated_at = ? WHERE id = ?`,
      [actualPrice, now, transfer.productId]);
    saveDatabase();
    eventBus.emit('agent_transfer.sold', 'agent_transfer', id, { actualPrice, commission });
  },

  markTransferReturned: (id) => {
    const transfer = get().getTransfer(id);
    if (!transfer) return;
    const now = new Date().toISOString();
    get().updateTransfer(id, { status: 'returned', returnedAt: now });
    const db = getDatabase();
    // Plan §Product §5: zurück zu OWN wenn Ware vom Agent zurückkommt
    db.run(`UPDATE products SET stock_status = 'in_stock', source_type = 'OWN', updated_at = ? WHERE id = ?`, [now, transfer.productId]);
    saveDatabase();
    eventBus.emit('agent_transfer.returned', 'agent_transfer', id, {});
  },

  markTransferSettled: (id, amount, method) => {
    if (typeof amount === 'number' && (!Number.isFinite(amount) || amount < 0)) {
      throw new Error('Settlement amount must be non-negative.');
    }
    const t = get().getTransfer(id);
    if (!t) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    const total = t.settlementAmount || 0;
    const prevPaid = t.settlementPaidAmount || 0;
    // Plan §Agent §4: wenn amount nicht angegeben → voll ausbuchen
    const paidNow = typeof amount === 'number' && amount > 0 ? amount : Math.max(0, total - prevPaid);
    const newPaid = Math.min(total, prevPaid + paidNow);
    const isFull = newPaid >= total - 0.005;

    // Plan §8 #5 — Audit-Trail: jede Teilzahlung als eigene Zeile in agent_settlement_payments.
    if (paidNow > 0) {
      const payId = uuid();
      db.run(
        `INSERT INTO agent_settlement_payments (id, transfer_id, amount, method, paid_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [payId, id, paidNow, method || 'cash', now.split('T')[0], isFull ? 'Final settlement' : 'Partial settlement', now]
      );
      trackInsert('agent_settlement_payments', payId, { transferId: id, amount: paidNow, method: method || 'cash' });
    }

    get().updateTransfer(id, {
      status: isFull ? 'settled' : 'sold',
      settlementStatus: isFull ? 'paid' : 'partial',
      settlementPaidAmount: newPaid,
      commissionPaidFrom: method ?? t.commissionPaidFrom ?? null,
      settledAt: isFull ? now : t.settledAt,
    });
    eventBus.emit('agent_transfer.settled', 'agent_transfer', id, { amount: paidNow, full: isFull });
  },

  // Plan §8 #5 — Settlement-Payment-Historie auslesen.
  getSettlementPayments: (transferId: string) => {
    try {
      const rows = query(
        `SELECT id, amount, method, paid_at, note, created_at FROM agent_settlement_payments
           WHERE transfer_id = ? ORDER BY paid_at ASC, created_at ASC`,
        [transferId]
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

  deleteTransfer: (id) => {
    const db = getDatabase();
    const transfer = get().getTransfer(id);
    if (transfer && transfer.status === 'transferred') {
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), transfer.productId]);
    }
    db.run(`DELETE FROM agent_transfers WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('agent_transfers', id);
    get().loadTransfers();
  },
}));
