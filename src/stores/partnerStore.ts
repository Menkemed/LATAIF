// ═══════════════════════════════════════════════════════════
// LATAIF — Partner Store (Plan §Partner + §Banking §5 Partner Investment)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Partner, PartnerTransaction, PartnerTransactionType } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
// CENTRAL-UI-PARITY R6C — die eine Stammdaten-Regel (Name Pflicht, Anteil 0–100 %).
import { partnerCreateInput, partnerUpdateInput } from '@/core/masterdata/masterdata-rules';
import {
  postPartnerTransactionReversed,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';
// CENTRAL-UI-PARITY R6D — Einlage, Entnahme und Gewinnausschüttung sind EINE Hausfolge.
import { moneyAction, recordPartnerTxInHouse } from '@/core/finance/money-house';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

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
  recordInvestment: (partnerId: string, amount: number, method: 'cash' | 'bank' | 'benefit', date?: string, notes?: string) => PartnerTransaction;
  recordWithdrawal: (partnerId: string, amount: number, method: 'cash' | 'bank' | 'benefit', date?: string, notes?: string) => PartnerTransaction;
  recordProfitDistribution: (partnerId: string, amount: number, method: 'cash' | 'bank' | 'benefit', date?: string, notes?: string) => PartnerTransaction;
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
    if (hydrateFromPrimary('store.partners.get', (d) => set(d as never))) return;
    try {
      set({ ...loadPartnersFor(localReadContext()), loading: false });
    } catch { set({ partners: [], loading: false }); }
  },

  loadTransactions: () => {
    if (hydrateFromPrimary('store.partners.get', (d) => set(d as never))) return;
    try {
      set(loadPartnerTransactionsFor(localReadContext()));
    } catch { set({ transactions: [] }); }
  },

  getPartner: (id) => get().partners.find(p => p.id === id),

  createPartner: (data) => {
    // R6C — die eine Regel: Name Pflicht und getrimmt, Anteil 0–100 % (vorher nahm das Feld jede
    // Zahl, auch 250 oder -10). Dieselbe Prüfung am Primary und fern.
    const input = partnerCreateInput(data as Record<string, unknown>);
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    db.run(
      `INSERT INTO partners (id, branch_id, name, phone, email, share_percentage, active, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [id, branchId, input.name, input.phone ?? null, input.email ?? null,
       input.sharePercentage, input.notes ?? null, now, now, userId]
    );
    saveDatabase();
    trackInsert('partners', id, { name: input.name });
    get().loadPartners();
    return get().getPartner(id)!;
  },

  updatePartner: (id, data) => {
    const input = partnerUpdateInput(data as Record<string, unknown>);
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', phone: 'phone', email: 'email',
      sharePercentage: 'share_percentage', notes: 'notes',
    };
    for (const [k, v] of Object.entries(input)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v ?? null); }
    }
    if (input.active !== undefined) { fields.push('active = ?'); values.push(input.active ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE partners SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('partners', id, input);
    get().loadPartners();
  },

  deletePartner: (id) => {
    // N1 — Referenz-Guard (wie deleteCustomer/deleteEmployee): einen Partner mit
    // Buchungshistorie NICHT hart loeschen, sonst bleiben partner_transactions +
    // ihre PARTNER_EQUITY-Ledger-Eintraege als Waisen (counterparty zeigt auf
    // geloeschten Partner). Stattdessen deaktivieren (active=0).
    const txCount = Number(query('SELECT COUNT(*) AS c FROM partner_transactions WHERE partner_id = ?', [id])[0]?.c || 0);
    if (txCount > 0) {
      throw new Error(`Cannot delete partner — ${txCount} transaction${txCount === 1 ? '' : 's'} reference this partner. Mark as inactive instead.`);
    }
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
    trackUpdate('partner_transactions', id, { paymentStatus: 'PAID', paidAt: now });
    get().loadTransactions();
  },

  deleteTransaction: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM partner_transactions WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('partner_transactions', id);
    get().loadTransactions();
    get().loadPartners();

    // ZIEL.md §3a — Reverse Ledger-Buchung beim Löschen.
    safePost(`postPartnerTransactionReversed(${id})`, () => {
      if (!hasLedgerEntries('PARTNER_TX', id)) return;
      if (hasReversalFor('PARTNER_TX', id)) return;
      postPartnerTransactionReversed(id);
    });
  },

  getPartnerLedger: (partnerId) => partnerLedgerFor(partnerId),
}));

// R6D — Einlage, Entnahme, Gewinnausschüttung. Vorher: Beleg, Zeile, Speichern, und DANACH die
// Buchung mit verschlucktem Fehler; der Partner wurde gar nicht nachgeschlagen, die Filiale im
// Zweifel 'branch-main'. Jetzt dieselbe Hausfolge wie die Maske und `partners.record_tx`, in einer
// Klammer. Ohne Datum: heute (wie bisher).
function recordTx(
  partnerId: string,
  type: PartnerTransactionType,
  amount: number,
  method: 'cash' | 'bank' | 'benefit',
  date: string | undefined,
  notes: string | undefined,
  get: () => PartnerStore
): PartnerTransaction {
  const tx = moneyAction((ctx) => recordPartnerTxInHouse({
    partnerId, kind: type, amount, method,
    date: date || new Date().toISOString().split('T')[0],
    notes,
  }, ctx));
  get().loadTransactions();
  get().loadPartners();
  return tx;
}


/** CENTRAL-UI-PARITY R2B — die Gesellschafter einer Filiale samt ihren Salden, zustandsfrei. */
export function loadPartnersFor(ctx: BusinessReadContext): { partners: Partner[] } {
  const rows = query('SELECT * FROM partners WHERE branch_id = ? ORDER BY name', [ctx.branchId]);
  const partners = rows.map(rowToPartner);
  for (const p of partners) Object.assign(p, partnerLedgerFor(p.id));
  return { partners };
}

/** CENTRAL-UI-PARITY R2B — die Bewegungen der Gesellschafter einer Filiale, zustandsfrei. */
export function loadPartnerTransactionsFor(ctx: BusinessReadContext): { transactions: PartnerTransaction[] } {
  const rows = query(
    'SELECT * FROM partner_transactions WHERE branch_id = ? ORDER BY transaction_date DESC, created_at DESC',
    [ctx.branchId]
  );
  return { transactions: rows.map(rowToTx) };
}

/**
 * CENTRAL-UI-PARITY R2B — die Salden eines Gesellschafters, als freie Funktion.
 *
 * Sie war nur als Store-Methode verpackt; gerechnet hat sie immer schon aus der Datenbank. Die
 * Einschraenkung auf die Filiale sitzt eine Ebene hoeher: der Gesellschafter selbst gehoert zu
 * genau einer, und nur dessen Kennung kommt hier an.
 */
export function partnerLedgerFor(partnerId: string): { totalInvested: number; totalWithdrawn: number; totalProfitShare: number; balance: number } {
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
}
