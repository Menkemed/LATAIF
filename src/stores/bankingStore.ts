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
import { formatInvoiceDisplay } from '@/core/utils/invoiceNumber';
import {
  postBankTransfer,
  postBankTransferReversed,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
// Buchungsfehler blockieren den operativen Domain-Insert NICHT.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

export type BankAccount = 'cash' | 'bank' | 'benefit';

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
  // User-facing date (YYYY-MM-DD oder ISO). Bleibt für Display.
  date: string;
  // Insert-Timestamp aus der jeweiligen Quelle (created_at). Wird als Tiebreaker
  // für Sortierung benutzt — sonst landen mehrere Bookings vom selben Tag in
  // beliebiger Reihenfolge. Fallback auf date wenn nicht verfügbar.
  createdAt: string;
  type: BankTransactionType;
  account: BankAccount;
  amount: number;
  flow: 'in' | 'out';
  relatedModule: string;
  relatedEntityId?: string;
  description?: string;
  // v0.3.3 — Verfolg-Link auf die Detail-Seite des Quell-Dokuments. undefined
  // wenn es keine sinnvolle Zielseite gibt (z.B. interne Bank-Transfers).
  link?: string;
}

interface BankingStore {
  transfers: BankTransfer[];
  loadTransfers: () => void;
  createTransfer: (data: { amount: number; direction: BankTransfer['direction']; transferDate?: string; notes?: string }) => BankTransfer;
  deleteTransfer: (id: string) => void;
  getTotals: () => { cashToBank: number; bankToCash: number };
  getTransactions: () => BankTransaction[];
  getBalances: () => { cash: number; bank: number; benefit: number };
}

function rowToTransfer(row: Record<string, unknown>): BankTransfer {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    amount: (row.amount as number) || 0,
    direction: (row.direction as BankTransfer['direction']) || 'CASH_TO_BANK',
    transferDate: row.transfer_date as string,
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

// Maps each BankTransfer.direction → {from, to} BankAccount.
// Single source of truth for parsing direction strings (kept in sync with
// TRANSFER_DIRECTION_MAP in ledger/posting.ts).
const TRANSFER_FLOW: Record<BankTransfer['direction'], { from: BankAccount; to: BankAccount; label: string }> = {
  CASH_TO_BANK:    { from: 'cash',    to: 'bank',    label: 'Cash → Bank'    },
  BANK_TO_CASH:    { from: 'bank',    to: 'cash',    label: 'Bank → Cash'    },
  CASH_TO_BENEFIT: { from: 'cash',    to: 'benefit', label: 'Cash → Benefit' },
  BENEFIT_TO_CASH: { from: 'benefit', to: 'cash',    label: 'Benefit → Cash' },
  BANK_TO_BENEFIT: { from: 'bank',    to: 'benefit', label: 'Bank → Benefit' },
  BENEFIT_TO_BANK: { from: 'benefit', to: 'bank',    label: 'Benefit → Bank' },
};

export function transferFlow(direction: BankTransfer['direction']) {
  return TRANSFER_FLOW[direction] || TRANSFER_FLOW.CASH_TO_BANK;
}

export function transferDirectionFor(from: BankAccount, to: BankAccount): BankTransfer['direction'] | null {
  for (const [dir, flow] of Object.entries(TRANSFER_FLOW)) {
    if (flow.from === from && flow.to === to) return dir as BankTransfer['direction'];
  }
  return null;
}

function accountFor(method: string | null | undefined): BankAccount {
  if (!method) return 'bank';
  const m = String(method).toLowerCase();
  if (m === 'cash') return 'cash';
  if (m === 'benefit') return 'benefit';
  // card, bank, bank_transfer → bank
  return 'bank';
}

// v0.3.3 — Verfolg-Link: Route auf die Detail-Seite des Quell-Dokuments einer
// Bank-Transaktion. Module mit eigener Detail-Page → Deep-Link; Module ohne
// Detail-Page → Listen-Seite (immer noch ein nuetzlicher Sprung). Bank-Transfers
// haben keine Zielseite (stehen auf der Banking-Page selbst) → kein Link.
function linkFor(relatedModule: string, relatedEntityId?: string): string | undefined {
  switch (relatedModule) {
    case 'invoice':        return relatedEntityId ? `/invoices/${relatedEntityId}` : undefined;
    case 'purchase':       return relatedEntityId ? `/purchases/${relatedEntityId}` : undefined;
    case 'order':          return relatedEntityId ? `/orders/${relatedEntityId}` : undefined;
    case 'repair':         return relatedEntityId ? `/repairs/${relatedEntityId}` : undefined;
    case 'consignment':    return relatedEntityId ? `/consignments/${relatedEntityId}` : undefined;
    case 'scrap_trade':    return relatedEntityId ? `/scrap-trades/${relatedEntityId}` : undefined;
    case 'agent_transfer': return relatedEntityId ? `/transfers/${relatedEntityId}` : undefined;
    case 'expense':        return '/expenses';
    case 'debt':           return '/debts';
    case 'partner':        return '/partners';
    case 'metal':          return '/metals';
    default:               return undefined; // transfer, sales/purchase_return: s. unten
  }
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
    const transfer = get().transfers.find(t => t.id === id)!;

    // ZIEL.md §3a — Ledger-Posting für Bank-Transfer.
    safePost(`postBankTransfer(${id})`, () => {
      if (hasLedgerEntries('BANK_TRANSFER', id)) return;
      postBankTransfer(transfer);
    });

    return transfer;
  },

  deleteTransfer: (id) => {
    const before = get().transfers.find(t => t.id === id);
    const db = getDatabase();
    db.run(`DELETE FROM bank_transfers WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('bank_transfers', id);
    get().loadTransfers();

    // ZIEL.md §3a — Storno der Ledger-Buchung beim Löschen.
    if (before) {
      safePost(`postBankTransferReversed(${id})`, () => {
        if (!hasLedgerEntries('BANK_TRANSFER', id)) return;
        if (hasReversalFor('BANK_TRANSFER', id)) return;
        postBankTransferReversed(before);
      });
    }
  },

  getTotals: () => {
    let cashToBank = 0, bankToCash = 0;
    for (const t of get().transfers) {
      if (t.direction === 'CASH_TO_BANK') cashToBank += t.amount;
      else if (t.direction === 'BANK_TO_CASH') bankToCash += t.amount;
      // benefit-Richtungen werden im neuen TRANSFER-Block einzeln gezählt;
      // hier nur die zwei Legacy-Felder, damit Analytics-Page kompatibel bleibt.
    }
    return { cashToBank, bankToCash };
  },

  getTransactions: () => {
    let branchId: string;
    try { branchId = currentBranchId(); } catch { return []; }
    const txs: BankTransaction[] = [];

    // Eine fehlerhafte Quell-Query (z.B. fehlende Spalte nach Schema-Drift) darf nicht
    // die ganze Banking-Page killen. Pro Block try/catch — bei Fehler nur loggen, weiter.
    const safeQuery = (label: string, sql: string, params: unknown[]): Record<string, unknown>[] => {
      try { return query(sql, params); }
      catch (err) {
        console.error(`[bankingStore] ${label} query failed:`, err);
        return [];
      }
    };

    // SALES_IN: invoice payments.
    // v0.3.2 — Card-Zahlungen NETTO zeigen: der Kartenprozessor zieht die Gebuehr
    // direkt ab, auf dem Bankkonto landet nur (Betrag − Card-Fee). Die zugehoerige
    // CardFees-Expense wird ueber den identischen created_at-Timestamp gematcht —
    // invoiceStore.recordPayment schreibt Payment + Fee-Expense mit demselben `now`.
    // Beschreibung nutzt formatInvoiceDisplay → exakt die Nummer die die Invoice
    // selbst anzeigt (No: 000009 / PINV-… ), nicht das rohe DB-Format.
    const payments = safeQuery('payments',
      `SELECT p.id, p.amount, p.method, p.received_at, p.invoice_id, p.created_at,
              i.invoice_number, i.status AS inv_status, i.special_mark AS inv_special,
              (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
                 WHERE e.category = 'CardFees' AND e.related_module = 'invoice'
                   AND e.related_entity_id = p.invoice_id
                   AND e.created_at = p.created_at
                   AND e.status != 'CANCELLED') AS card_fee
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.branch_id = ?`,
      [branchId]
    );
    for (const p of payments) {
      const date = (p.received_at as string) || '';
      const method = (p.method as string) || '';
      const gross = (p.amount as number) || 0;
      const fee = method.toLowerCase() === 'card' ? ((p.card_fee as number) || 0) : 0;
      const invLabel = formatInvoiceDisplay({
        invoiceNumber: (p.invoice_number as string) || '',
        status: (p.inv_status as string) || undefined,
        specialMark: Number(p.inv_special) === 1,
      });
      txs.push({
        id: `pay-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
        type: 'SALES_IN',
        account: accountFor(method),
        amount: gross - fee,
        flow: 'in',
        relatedModule: 'invoice',
        relatedEntityId: p.invoice_id as string,
        description: `Payment · ${invLabel} · ${method}${fee > 0 ? ` (net of ${fee.toFixed(3)} card fee)` : ''}`,
      });
    }

    // PURCHASE_OUT: purchase payments
    const purchPay = safeQuery('purchase_payments',
      `SELECT pp.id, pp.amount, pp.method, pp.paid_at, pp.purchase_id, p.purchase_number, pp.created_at AS created_at
       FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
       WHERE p.branch_id = ?`,
      [branchId]
    );
    for (const p of purchPay) {
      const date = (p.paid_at as string) || '';
      txs.push({
        id: `ppay-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
        type: 'PURCHASE_OUT',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'out',
        relatedModule: 'purchase',
        relatedEntityId: p.purchase_id as string,
        description: `Purchase payment · ${p.purchase_number || ''} · ${p.method}`,
      });
    }

    // EXPENSE_OUT: nur tatsächlich bezahlte Beträge (paid_amount > 0).
    // Pending-Expenses (Supplier-Payables, z.B. Repair-Workshop-Kosten) bewegen
    // noch kein Geld → dürfen nicht als Cashflow erscheinen.
    // v0.3.2 — Auto-CardFees-Expenses (related_module='invoice') sind bereits in
    // der SALES_IN-Zeile netto verrechnet → hier ausschliessen, sonst Doppel-
    // zaehlung falls die Fee-Expense je manuell als bezahlt markiert wird.
    const expenses = safeQuery('expenses',
      `SELECT id, COALESCE(paid_amount, 0) AS paid_amount, payment_method,
              expense_date, description, expense_number, category, created_at
       FROM expenses
       WHERE branch_id = ? AND status != 'CANCELLED' AND COALESCE(paid_amount, 0) > 0
         AND NOT (category = 'CardFees' AND related_module IN ('invoice', 'order', 'repair'))`,
      [branchId]
    );
    for (const e of expenses) {
      const date = (e.expense_date as string) || '';
      txs.push({
        id: `exp-${e.id}`,
        date,
        createdAt: (e.created_at as string) || date,
        type: 'EXPENSE_OUT',
        account: accountFor(e.payment_method as string),
        amount: (e.paid_amount as number) || 0,
        flow: 'out',
        relatedModule: 'expense',
        relatedEntityId: e.id as string,
        description: `${e.expense_number || ''} · ${e.category || ''}${e.description ? ' · ' + e.description : ''}`,
      });
    }

    // LOAN_IN / LOAN_OUT: initial amount + repayments
    // Plan §Loan §3: MONEY_GIVEN → receivable (cash out at inception, in at repayment)
    //                MONEY_RECEIVED → payable (cash in at inception, out at repayment)
    const debts = safeQuery('debts',
      `SELECT id, direction, amount, source, counterparty, created_at
       FROM debts WHERE branch_id = ?`,
      [branchId]
    );
    for (const d of debts) {
      const dir = String(d.direction || '').toUpperCase();
      const isGiven = dir === 'MONEY_GIVEN' || dir === 'WE_LEND';
      const date = (d.created_at as string) || '';
      txs.push({
        id: `debt-${d.id}`,
        date,
        createdAt: date,
        type: isGiven ? 'LOAN_OUT' : 'LOAN_IN',
        account: accountFor(d.source as string),
        amount: (d.amount as number) || 0,
        flow: isGiven ? 'out' : 'in',
        relatedModule: 'debt',
        relatedEntityId: d.id as string,
        description: `Loan ${isGiven ? 'given to' : 'received from'} ${d.counterparty || ''}`,
      });
    }
    const debtPay = safeQuery('debt_payments',
      `SELECT dp.id, dp.amount, dp.source, dp.paid_at, dp.debt_id, d.direction, d.counterparty, dp.created_at AS created_at
       FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id
       WHERE d.branch_id = ?`,
      [branchId]
    );
    for (const p of debtPay) {
      const dir = String(p.direction || '').toUpperCase();
      const isGiven = dir === 'MONEY_GIVEN' || dir === 'WE_LEND';
      const date = (p.paid_at as string) || '';
      // Repayment: if we gave → we RECEIVE back; if we received → we PAY back
      txs.push({
        id: `dpay-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
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
    const partnerTx = safeQuery('partner_transactions',
      `SELECT pt.id, pt.amount, pt.type, pt.method, pt.transaction_date, pt.partner_id, pt.transaction_number, pr.name, pt.created_at AS created_at
       FROM partner_transactions pt LEFT JOIN partners pr ON pr.id = pt.partner_id
       WHERE pt.branch_id = ?`,
      [branchId]
    );
    for (const p of partnerTx) {
      const type = String(p.type || '').toUpperCase();
      const isIn = type === 'INVESTMENT' || type === 'PARTNER_INVESTMENT';
      const date = (p.transaction_date as string) || '';
      txs.push({
        id: `pt-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
        type: isIn ? 'PARTNER_INVESTMENT_IN' : 'PARTNER_WITHDRAWAL_OUT',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: isIn ? 'in' : 'out',
        relatedModule: 'partner',
        relatedEntityId: p.partner_id as string,
        description: `${p.transaction_number || ''} · ${type} · ${p.name || ''}`,
      });
    }

    // TRANSFER: cash ↔ bank ↔ benefit (two legs so they balance)
    const transfers = get().transfers;
    for (const t of transfers) {
      const tCreated = t.createdAt || t.transferDate;
      const flow = transferFlow(t.direction);
      const desc = `Transfer ${flow.label}`;
      txs.push({
        id: `tf-${t.id}-out`, date: t.transferDate, createdAt: tCreated, type: 'TRANSFER',
        account: flow.from, amount: t.amount, flow: 'out',
        relatedModule: 'transfer', relatedEntityId: t.id,
        description: desc,
      });
      txs.push({
        id: `tf-${t.id}-in`, date: t.transferDate, createdAt: tCreated, type: 'TRANSFER',
        account: flow.to, amount: t.amount, flow: 'in',
        relatedModule: 'transfer', relatedEntityId: t.id,
        description: desc,
      });
    }

    // CONSIGNOR PAYOUT (Plan §Commission §8): du schuldest Besitzer, Auszahlung ist Outflow.
    // Wird als EXPENSE_OUT kategorisiert (liability settlement).
    const payouts = safeQuery('consignment_payouts',
      `SELECT id, consignment_number, payout_amount, payout_method, payout_date, updated_at
       FROM consignments WHERE branch_id = ? AND payout_status = 'paid' AND payout_amount > 0`,
      [branchId]
    );
    for (const p of payouts) {
      const date = (p.payout_date as string) || '';
      txs.push({
        id: `cpay-${p.id}`,
        date,
        createdAt: (p.updated_at as string) || date,
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
    // Fix 2026-05: sales_returns hat KEIN updated_at — vorher silent empty wegen
    // safeQuery-Schluck. Nur created_at + refund_paid_date.
    const salesRet = safeQuery('sales_returns',
      `SELECT id, refund_amount, refund_paid_amount, refund_paid_date, refund_method, return_date, return_number, invoice_id, created_at,
              (SELECT cn.id FROM credit_notes cn WHERE cn.sales_return_id = sales_returns.id LIMIT 1) AS credit_note_id
       FROM sales_returns WHERE branch_id = ? AND status != 'REJECTED'
         AND (refund_paid_amount > 0 OR refund_amount > 0)`,
      [branchId]
    );
    for (const r of salesRet) {
      const paid = (r.refund_paid_amount as number) || 0;
      const amount = paid > 0 ? paid : ((r.refund_amount as number) || 0);
      if (amount <= 0) continue;
      const date = (r.refund_paid_date as string) || (r.return_date as string) || '';
      txs.push({
        id: `sret-${r.id}`,
        date,
        createdAt: (r.created_at as string) || date,
        type: 'REFUND',
        account: accountFor(r.refund_method as string),
        amount,
        flow: 'out',
        relatedModule: 'sales_return',
        relatedEntityId: r.id as string,
        description: `Sales refund · ${r.return_number || ''}`,
        // v0.3.3 — Sales-Refund verlinkt auf die Credit Note (das eigentliche
        // Refund-Dokument). Fallback auf die Quell-Invoice falls (noch) keine
        // Credit Note zum Return existiert.
        link: (r.credit_note_id as string)
          ? `/credit-notes/${r.credit_note_id}`
          : ((r.invoice_id as string) ? `/invoices/${r.invoice_id}` : undefined),
      });
    }

    // REFUND_IN: purchase returns with refund_amount > 0 (money back from supplier)
    const purchRet = safeQuery('purchase_returns',
      `SELECT id, refund_amount, refund_method, return_date, return_number, purchase_id, created_at
       FROM purchase_returns WHERE branch_id = ? AND refund_amount > 0 AND status != 'CANCELLED'`,
      [branchId]
    );
    for (const r of purchRet) {
      const date = (r.return_date as string) || '';
      txs.push({
        id: `pret-${r.id}`,
        date,
        createdAt: (r.created_at as string) || date,
        type: 'REFUND',
        account: accountFor(r.refund_method as string),
        amount: (r.refund_amount as number) || 0,
        flow: 'in',
        relatedModule: 'purchase_return',
        relatedEntityId: r.id as string,
        description: `Purchase refund · ${r.return_number || ''}`,
        // v0.3.3 — Refund hat keine eigene Detail-Page → auf die Quell-Purchase verlinken.
        link: (r.purchase_id as string) ? `/purchases/${r.purchase_id}` : undefined,
      });
    }

    // Plan §8 #9 — Order-Payments (Anzahlungen + Zahlungen vor Invoice-Erstellung)
    // v0.7.26 — Karten-Anzahlungen NETTO zeigen (Brutto − gebuchte CardFee), analog
    // zu den Invoice-Zahlungen. Match ueber CardFees/related_module='order' + den
    // identischen created_at-Timestamp (bookCardFee schreibt denselben `now`).
    const orderPay = safeQuery('order_payments',
      `SELECT op.id, op.amount, op.method, op.paid_at, op.order_id, o.order_number,
              COALESCE(op.converted_to_invoice, 0) AS converted, op.created_at AS created_at,
              (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
                 WHERE e.category = 'CardFees' AND e.related_module = 'order'
                   AND e.related_entity_id = op.order_id
                   AND e.created_at = op.created_at
                   AND e.status != 'CANCELLED') AS card_fee
         FROM order_payments op JOIN orders o ON o.id = op.order_id
         WHERE o.branch_id = ?`,
      [branchId]
    );
    for (const p of orderPay) {
      // Bereits in Invoice konvertiert? Dann dort schon gezählt — skip.
      if (Number(p.converted) === 1) continue;
      const date = (p.paid_at as string) || '';
      const method = (p.method as string) || '';
      const gross = (p.amount as number) || 0;
      const fee = method.toLowerCase() === 'card' ? ((p.card_fee as number) || 0) : 0;
      txs.push({
        id: `opay-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
        type: 'SALES_IN',
        account: accountFor(method),
        amount: gross - fee,
        flow: 'in',
        relatedModule: 'order',
        relatedEntityId: p.order_id as string,
        description: `Order payment · ${p.order_number || ''} · ${method}${fee > 0 ? ` (net of ${fee.toFixed(3)} card fee)` : ''}`,
      });
    }

    // Plan §8 #9 — Repair Customer-Payments (direkt auf repair.customer_paid_amount).
    // Abzüglich bereits in einer verknüpften Invoice gezählter Beträge (invoice_id gesetzt & FINAL).
    const repairPay = safeQuery('repair_payments',
      `SELECT r.id, r.repair_number, r.customer_paid_amount, r.customer_payment_method, r.customer_payment_date, r.invoice_id, r.updated_at,
         (SELECT COALESCE(SUM(e.amount),0) FROM expenses e
            WHERE e.category = 'CardFees' AND e.related_module = 'repair'
              AND e.related_entity_id = r.id AND e.status != 'CANCELLED') AS card_fee
         FROM repairs r WHERE r.branch_id = ? AND r.customer_paid_amount > 0`,
      [branchId]
    );
    for (const r of repairPay) {
      // Wenn an eine Invoice gekoppelt → Zahlung läuft via invoice.payments (doppelt vermeiden).
      if (r.invoice_id) continue;
      const date = (r.customer_payment_date as string) || '';
      // v0.7.26 — Karten-Zahlung netto: gebuchte CardFee abziehen (Processor zieht sofort ab).
      const method = (r.customer_payment_method as string) || '';
      const gross = (r.customer_paid_amount as number) || 0;
      const fee = method.toLowerCase() === 'card' ? ((r.card_fee as number) || 0) : 0;
      txs.push({
        id: `rpay-${r.id}`,
        date,
        createdAt: (r.updated_at as string) || date,
        type: 'SALES_IN',
        account: accountFor(method),
        amount: gross - fee,
        flow: 'in',
        relatedModule: 'repair',
        relatedEntityId: r.id as string,
        description: `Repair charge · ${r.repair_number || ''}${fee > 0 ? ` (net of ${fee.toFixed(3)} card fee)` : ''}`,
      });
    }

    // Plan §8 #9 — Metal Payments (Verkauf von Edelmetallen).
    const metalPay = safeQuery('metal_payments',
      `SELECT mp.id, mp.amount, mp.method, mp.paid_at, mp.metal_id, pm.metal_type, mp.created_at AS created_at
         FROM metal_payments mp LEFT JOIN precious_metals pm ON pm.id = mp.metal_id
         WHERE pm.branch_id = ?`,
      [branchId]
    );
    for (const p of metalPay) {
      const date = (p.paid_at as string) || '';
      txs.push({
        id: `mpay-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
        type: 'SALES_IN',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'in',
        relatedModule: 'metal',
        relatedEntityId: p.metal_id as string,
        description: `Metal sale · ${p.metal_type || 'precious_metal'}`,
      });
    }

    // Plan §8 #9 — Agent Settlement Payments: Der Agent verkauft unsere Ware
    // und zahlt uns den Erlös abzüglich Kommission aus → Geld kommt REIN.
    // WICHTIG: Nur Transfers OHNE Invoice einbeziehen — wenn eine Invoice
    // existiert, läuft der Cashflow über die Invoice-Payments (in `payments`-
    // Tabelle, oben schon als SALES_IN gezählt). Sonst Doppelbuchung.
    const agentPay = safeQuery('agent_settlement_payments',
      `SELECT asp.id, asp.amount, asp.method, asp.paid_at, asp.transfer_id, at.agent_id, a.name AS agent_name, asp.created_at AS created_at
         FROM agent_settlement_payments asp
         JOIN agent_transfers at ON at.id = asp.transfer_id
         LEFT JOIN agents a ON a.id = at.agent_id
         WHERE at.branch_id = ? AND at.invoice_id IS NULL`,
      [branchId]
    );
    for (const p of agentPay) {
      const date = (p.paid_at as string) || '';
      txs.push({
        id: `apay-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
        type: 'SALES_IN',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: 'in',
        relatedModule: 'agent_transfer',
        relatedEntityId: p.transfer_id as string,
        description: `Agent settlement received · ${p.agent_name || p.transfer_id}`,
      });
    }

    // Scrap Gold Trade Payments — Split-Payments pro Trade. Jeder OUT-Split
    // wird zu PURCHASE_OUT (Geld an Seller), jeder IN-Split zu SALES_IN
    // (Geld vom Buyer). Excluded: cancelled trades.
    const scrapPay = safeQuery('scrap_trade_payments',
      `SELECT stp.id, stp.scrap_trade_id, stp.direction, stp.method, stp.amount, stp.created_at,
              st.trade_number, st.trade_date, st.seller_name, st.buyer_name, st.status
         FROM scrap_trade_payments stp
         JOIN scrap_trades st ON st.id = stp.scrap_trade_id
        WHERE st.branch_id = ? AND st.status != 'cancelled'`,
      [branchId]
    );
    for (const p of scrapPay) {
      const isOut = (p.direction as string) === 'OUT';
      const counterparty = isOut ? (p.seller_name as string) : (p.buyer_name as string);
      const date = (p.trade_date as string) || '';
      txs.push({
        id: `sgt-${p.id}`,
        date,
        createdAt: (p.created_at as string) || date,
        type: isOut ? 'PURCHASE_OUT' : 'SALES_IN',
        account: accountFor(p.method as string),
        amount: (p.amount as number) || 0,
        flow: isOut ? 'out' : 'in',
        relatedModule: 'scrap_trade',
        relatedEntityId: p.scrap_trade_id as string,
        description: isOut
          ? `Scrap purchase · ${p.trade_number || ''} · ${counterparty || ''}`
          : `Scrap sale · ${p.trade_number || ''} · ${counterparty || ''}`,
      });
    }

    // Sort: primär nach Datum (neueste zuerst), sekundär nach Insert-Timestamp.
    // Fix 2026-05: date-Felder kommen aus verschiedenen DB-Spalten — manche sind
    // YYYY-MM-DD, manche voller ISO-String. Beim String-Compare würde '2026-05-06'
    // gegen '2026-05-06T22:33:00Z' falsche Ergebnisse geben. Daher: primär die
    // ersten 10 Zeichen (Datum-Anteil), sekundär createdAt als voller Timestamp.
    txs.sort((a, b) => {
      const dA = (a.date || '').slice(0, 10);
      const dB = (b.date || '').slice(0, 10);
      const d = dB.localeCompare(dA);
      if (d !== 0) return d;
      const cA = a.createdAt || a.date || '';
      const cB = b.createdAt || b.date || '';
      return cB.localeCompare(cA);
    });
    // v0.3.3 — Verfolg-Link pro Transaktion ableiten (sales/purchase_return
    // haben ihren Link oben schon gesetzt → nicht ueberschreiben).
    for (const t of txs) {
      if (!t.link) t.link = linkFor(t.relatedModule, t.relatedEntityId);
    }
    return txs;
  },

  getBalances: () => {
    const txs = get().getTransactions();
    let cash = 0, bank = 0, benefit = 0;
    for (const t of txs) {
      const sign = t.flow === 'in' ? 1 : -1;
      if (t.account === 'cash') cash += sign * t.amount;
      else if (t.account === 'benefit') benefit += sign * t.amount;
      else bank += sign * t.amount;
    }
    return { cash, bank, benefit };
  },
}));
