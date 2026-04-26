// ═══════════════════════════════════════════════════════════
// LATAIF — Banking Store (Plan §Banking)
// Cash↔Bank Transfers + Unified transaction log + live balances.
// Plan §Banking §5: 9 transaction types — SALES_IN, PURCHASE_OUT,
// EXPENSE_OUT, LOAN_IN, LOAN_OUT, PARTNER_INVESTMENT_IN,
// PARTNER_WITHDRAWAL_OUT, TRANSFER, REFUND.
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { BankTransfer } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackDelete } from '@/core/sync/track';

export type BankAccount = 'cash' | 'bank';

// Plan §Banking §5: 9 canonical types. REFUND wird per `flow` in 'in'/'out' unterschieden.
export type BankTransactionType =
  | 'SALES_IN'
  | 'PURCHASE_OUT'
  | 'EXPENSE_OUT'
  | 'LOAN_IN'
  | 'LOAN_OUT'
  | 'PARTNER_INVESTMENT_IN'
  | 'PARTNER_WITHDRAWAL_OUT'
  | 'TRANSFER'
  | 'REFUND';

export interface BankTransaction {
  id: string;
  date: string;
  type: BankTransactionType;
  account: BankAccount;
  amount: number;
  flow: 'in' | 'out';
  relatedModule: string;
  relatedEntityId?: string;
  description?: string;
}

interface BankingStore {
  transfers: BankTransfer[];
  loadTransfers: () => void;
  createTransfer: (data: { amount: number; direction: 'CASH_TO_BANK' | 'BANK_TO_CASH'; transferDate?: string; notes?: string }) => BankTransfer;
  deleteTransfer: (id: string) => void;
  getTotals: () => { cashToBank: number; bankToCash: number };
  getTransactions: () => BankTransaction[];
  getBalances: () => { cash: number; bank: number };
}

function rowToTransfer(row: Record<string, unknown>): BankTransfer {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    amount: (row.amount as number) || 0,
    direction: (row.direction as 'CASH_TO_BANK' | 'BANK_TO_CASH') || 'CASH_TO_BANK',
    transferDate: row.transfer_date as string,
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function accountFor(method: string | null | undefined): BankAccount {
  if (!method) return 'bank';
  const m = String(method).toLowerCase();
  if (m === 'cash') return 'cash';
  // card, bank, bank_transfer, crypto → bank
  return 'bank';
}

export const useBankingStore = create<BankingStore>((set, get) => ({
  transfers: [],

  loadTransfers: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM bank_transfers WHERE branch_id = ? ORDER BY transfer_date DESC, created_at DESC', [branchId]);
      set({ transfers: rows.map(rowToTransfer) });
    } catch { set({ transfers: [] }); }
  },

  createTransfer: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const date = data.transferDate || now.split('T')[0];
    db.run(
      `INSERT INTO bank_transfers (id, branch_id, amount, direction, transfer_date, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, data.amount, data.direction, date, data.notes || null, now, userId]
    );
    saveDatabase();
    trackInsert('bank_transfers', id, { amount: data.amount, direction: data.direction });
    get().loadTransfers();
    return get().transfers.find(t => t.id === id)!;
  },

  deleteTransfer: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM bank_transfers WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('bank_transfers', id);
    get().loadTransfers();
  },

  getTotals: () => {
    let cashToBank = 0, bankToCash = 0;
    for (const t of get().transfers) {
      if (t.direction === 'CASH_TO_BANK') cashToBank += t.amount;
      else bankToCash += t.amount;
    }
    return { cashToBank, bankToCash };
  },

  getTransactions: () => {
    let branchId: string;
    try { branchId = currentBranchId(); } catch { return []; }
    const txs: BankTransaction[] = [];

    // SALES_IN: invoice payments
    const payments = query(
      `SELECT p.id, p.amount, p.method, p.received_at, p.invoice_id, i.invoice_number
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.branch_id = ?`,
      [branchId]
    );
    for (const p of payments) {
      txs.push({
        id: `pay-${p.id}`,
        date: (p.received_at as string) || '',
        type: 'SALES_IN',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'in',
        relatedModule: 'invoice',
        relatedEntityId: p.invoice_id as string,
        description: `Payment · ${p.invoice_number || ''} · ${p.method}`,
      });
    }

    // PURCHASE_OUT: purchase payments
    const purchPay = query(
      `SELECT pp.id, pp.amount, pp.method, pp.paid_at, pp.purchase_id, p.purchase_number
       FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
       WHERE p.branch_id = ?`,
      [branchId]
    );
    for (const p of purchPay) {
      txs.push({
        id: `ppay-${p.id}`,
        date: (p.paid_at as string) || '',
        type: 'PURCHASE_OUT',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'out',
        relatedModule: 'purchase',
        relatedEntityId: p.purchase_id as string,
        description: `Purchase payment · ${p.purchase_number || ''} · ${p.method}`,
      });
    }

    // EXPENSE_OUT: expenses
    const expenses = query(
      `SELECT id, amount, payment_method, expense_date, description, expense_number, category
       FROM expenses WHERE branch_id = ?`,
      [branchId]
    );
    for (const e of expenses) {
      txs.push({
        id: `exp-${e.id}`,
        date: (e.expense_date as string) || '',
        type: 'EXPENSE_OUT',
        account: accountFor(e.payment_method as string),
        amount: (e.amount as number) || 0,
        flow: 'out',
        relatedModule: 'expense',
        relatedEntityId: e.id as string,
        description: `${e.expense_number || ''} · ${e.category || ''}${e.description ? ' · ' + e.description : ''}`,
      });
    }

    // LOAN_IN / LOAN_OUT: initial amount + repayments
    // Plan §Loan §3: MONEY_GIVEN → receivable (cash out at inception, in at repayment)
    //                MONEY_RECEIVED → payable (cash in at inception, out at repayment)
    const debts = query(
      `SELECT id, direction, amount, source, counterparty, created_at
       FROM debts WHERE branch_id = ?`,
      [branchId]
    );
    for (const d of debts) {
      const dir = String(d.direction || '').toUpperCase();
      const isGiven = dir === 'MONEY_GIVEN' || dir === 'WE_LEND';
      txs.push({
        id: `debt-${d.id}`,
        date: (d.created_at as string) || '',
        type: isGiven ? 'LOAN_OUT' : 'LOAN_IN',
        account: accountFor(d.source as string),
        amount: (d.amount as number) || 0,
        flow: isGiven ? 'out' : 'in',
        relatedModule: 'debt',
        relatedEntityId: d.id as string,
        description: `Loan ${isGiven ? 'given to' : 'received from'} ${d.counterparty || ''}`,
      });
    }
    const debtPay = query(
      `SELECT dp.id, dp.amount, dp.source, dp.paid_at, dp.debt_id, d.direction, d.counterparty
       FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id
       WHERE d.branch_id = ?`,
      [branchId]
    );
    for (const p of debtPay) {
      const dir = String(p.direction || '').toUpperCase();
      const isGiven = dir === 'MONEY_GIVEN' || dir === 'WE_LEND';
      // Repayment: if we gave → we RECEIVE back; if we received → we PAY back
      txs.push({
        id: `dpay-${p.id}`,
        date: (p.paid_at as string) || '',
        type: isGiven ? 'LOAN_IN' : 'LOAN_OUT',
        account: accountFor(p.source as string),
        amount: (p.amount as number) || 0,
        flow: isGiven ? 'in' : 'out',
        relatedModule: 'debt',
        relatedEntityId: p.debt_id as string,
        description: `Loan repayment · ${p.counterparty || ''}`,
      });
    }

    // PARTNER_INVESTMENT_IN / PARTNER_WITHDRAWAL_OUT / PARTNER_PROFIT_OUT
    const partnerTx = query(
      `SELECT pt.id, pt.amount, pt.type, pt.method, pt.transaction_date, pt.partner_id, pt.transaction_number, pr.name
       FROM partner_transactions pt LEFT JOIN partners pr ON pr.id = pt.partner_id
       WHERE pt.branch_id = ?`,
      [branchId]
    );
    for (const p of partnerTx) {
      const type = String(p.type || '').toUpperCase();
      const isIn = type === 'INVESTMENT' || type === 'PARTNER_INVESTMENT';
      txs.push({
        id: `pt-${p.id}`,
        date: (p.transaction_date as string) || '',
        type: isIn ? 'PARTNER_INVESTMENT_IN' : 'PARTNER_WITHDRAWAL_OUT',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: isIn ? 'in' : 'out',
        relatedModule: 'partner',
        relatedEntityId: p.partner_id as string,
        description: `${p.transaction_number || ''} · ${type} · ${p.name || ''}`,
      });
    }

    // TRANSFER: cash↔bank (two legs so they balance)
    const transfers = get().transfers;
    for (const t of transfers) {
      if (t.direction === 'CASH_TO_BANK') {
        txs.push({
          id: `tf-${t.id}-out`, date: t.transferDate, type: 'TRANSFER',
          account: 'cash', amount: t.amount, flow: 'out',
          relatedModule: 'transfer', relatedEntityId: t.id,
          description: 'Transfer Cash → Bank',
        });
        txs.push({
          id: `tf-${t.id}-in`, date: t.transferDate, type: 'TRANSFER',
          account: 'bank', amount: t.amount, flow: 'in',
          relatedModule: 'transfer', relatedEntityId: t.id,
          description: 'Transfer Cash → Bank',
        });
      } else {
        txs.push({
          id: `tf-${t.id}-out`, date: t.transferDate, type: 'TRANSFER',
          account: 'bank', amount: t.amount, flow: 'out',
          relatedModule: 'transfer', relatedEntityId: t.id,
          description: 'Transfer Bank → Cash',
        });
        txs.push({
          id: `tf-${t.id}-in`, date: t.transferDate, type: 'TRANSFER',
          account: 'cash', amount: t.amount, flow: 'in',
          relatedModule: 'transfer', relatedEntityId: t.id,
          description: 'Transfer Bank → Cash',
        });
      }
    }

    // CONSIGNOR PAYOUT (Plan §Commission §8): du schuldest Besitzer, Auszahlung ist Outflow.
    // Wird als EXPENSE_OUT kategorisiert (liability settlement).
    const payouts = query(
      `SELECT id, consignment_number, payout_amount, payout_method, payout_date
       FROM consignments WHERE branch_id = ? AND payout_status = 'paid' AND payout_amount > 0`,
      [branchId]
    );
    for (const p of payouts) {
      txs.push({
        id: `cpay-${p.id}`,
        date: (p.payout_date as string) || '',
        type: 'EXPENSE_OUT',
        account: accountFor(p.payout_method as string),
        amount: (p.payout_amount as number) || 0,
        flow: 'out',
        relatedModule: 'consignment',
        relatedEntityId: p.id as string,
        description: `Consignor payout · ${p.consignment_number || ''}`,
      });
    }

    // REFUND_OUT: sales returns — nutze refund_paid_amount damit Teilzahlungen
    // via recordRefundPayment() auch im Cashflow auftauchen (Plan §Returns Fix).
    const salesRet = query(
      `SELECT id, refund_amount, refund_paid_amount, refund_paid_date, refund_method, return_date, return_number, invoice_id
       FROM sales_returns WHERE branch_id = ? AND status != 'REJECTED'
         AND (refund_paid_amount > 0 OR refund_amount > 0)`,
      [branchId]
    );
    for (const r of salesRet) {
      const paid = (r.refund_paid_amount as number) || 0;
      const amount = paid > 0 ? paid : ((r.refund_amount as number) || 0);
      if (amount <= 0) continue;
      txs.push({
        id: `sret-${r.id}`,
        date: (r.refund_paid_date as string) || (r.return_date as string) || '',
        type: 'REFUND',
        account: accountFor(r.refund_method as string),
        amount,
        flow: 'out',
        relatedModule: 'sales_return',
        relatedEntityId: r.id as string,
        description: `Sales refund · ${r.return_number || ''}`,
      });
    }

    // REFUND_IN: purchase returns with refund_amount > 0 (money back from supplier)
    const purchRet = query(
      `SELECT id, refund_amount, refund_method, return_date, return_number, purchase_id
       FROM purchase_returns WHERE branch_id = ? AND refund_amount > 0 AND status != 'CANCELLED'`,
      [branchId]
    );
    for (const r of purchRet) {
      txs.push({
        id: `pret-${r.id}`,
        date: (r.return_date as string) || '',
        type: 'REFUND',
        account: accountFor(r.refund_method as string),
        amount: (r.refund_amount as number) || 0,
        flow: 'in',
        relatedModule: 'purchase_return',
        relatedEntityId: r.id as string,
        description: `Purchase refund · ${r.return_number || ''}`,
      });
    }

    // Plan §8 #9 — Order-Payments (Anzahlungen + Zahlungen vor Invoice-Erstellung)
    const orderPay = query(
      `SELECT op.id, op.amount, op.method, op.paid_at, op.order_id, o.order_number,
              COALESCE(op.converted_to_invoice, 0) AS converted
         FROM order_payments op JOIN orders o ON o.id = op.order_id
         WHERE o.branch_id = ?`,
      [branchId]
    );
    for (const p of orderPay) {
      // Bereits in Invoice konvertiert? Dann dort schon gezählt — skip.
      if (Number(p.converted) === 1) continue;
      txs.push({
        id: `opay-${p.id}`,
        date: (p.paid_at as string) || '',
        type: 'SALES_IN',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'in',
        relatedModule: 'order',
        relatedEntityId: p.order_id as string,
        description: `Order payment · ${p.order_number || ''} · ${p.method}`,
      });
    }

    // Plan §8 #9 — Repair Customer-Payments (direkt auf repair.customer_paid_amount).
    // Abzüglich bereits in einer verknüpften Invoice gezählter Beträge (invoice_id gesetzt & FINAL).
    const repairPay = query(
      `SELECT r.id, r.repair_number, r.customer_paid_amount, r.customer_payment_method, r.customer_payment_date, r.invoice_id
         FROM repairs r WHERE r.branch_id = ? AND r.customer_paid_amount > 0`,
      [branchId]
    );
    for (const r of repairPay) {
      // Wenn an eine Invoice gekoppelt → Zahlung läuft via invoice.payments (doppelt vermeiden).
      if (r.invoice_id) continue;
      txs.push({
        id: `rpay-${r.id}`,
        date: (r.customer_payment_date as string) || '',
        type: 'SALES_IN',
        account: accountFor(r.customer_payment_method as string),
        amount: (r.customer_paid_amount as number) || 0,
        flow: 'in',
        relatedModule: 'repair',
        relatedEntityId: r.id as string,
        description: `Repair charge · ${r.repair_number || ''}`,
      });
    }

    // Plan §8 #9 — Metal Payments (Verkauf von Edelmetallen).
    const metalPay = query(
      `SELECT mp.id, mp.amount, mp.method, mp.paid_at, mp.metal_id, pm.metal_type
         FROM metal_payments mp LEFT JOIN precious_metals pm ON pm.id = mp.metal_id
         WHERE pm.branch_id = ?`,
      [branchId]
    );
    for (const p of metalPay) {
      txs.push({
        id: `mpay-${p.id}`,
        date: (p.paid_at as string) || '',
        type: 'SALES_IN',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'in',
        relatedModule: 'metal',
        relatedEntityId: p.metal_id as string,
        description: `Metal sale · ${p.metal_type || 'precious_metal'}`,
      });
    }

    // Plan §8 #9 — Agent Settlement Payments (Abrechnung gegen Agenten).
    const agentPay = query(
      `SELECT asp.id, asp.amount, asp.method, asp.paid_at, asp.transfer_id, at.agent_id, a.name AS agent_name
         FROM agent_settlement_payments asp
         JOIN agent_transfers at ON at.id = asp.transfer_id
         LEFT JOIN agents a ON a.id = at.agent_id
         WHERE at.branch_id = ?`,
      [branchId]
    );
    for (const p of agentPay) {
      txs.push({
        id: `apay-${p.id}`,
        date: (p.paid_at as string) || '',
        type: 'EXPENSE_OUT',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'out',
        relatedModule: 'agent_transfer',
        relatedEntityId: p.transfer_id as string,
        description: `Agent settlement · ${p.agent_name || p.transfer_id}`,
      });
    }

    txs.sort((a, b) => b.date.localeCompare(a.date));
    return txs;
  },

  getBalances: () => {
    const txs = get().getTransactions();
    let cash = 0, bank = 0;
    for (const t of txs) {
      const sign = t.flow === 'in' ? 1 : -1;
      if (t.account === 'cash') cash += sign * t.amount;
      else bank += sign * t.amount;
    }
    return { cash, bank };
  },
}));
