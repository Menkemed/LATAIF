// Unified Payables-View über alle „wir schulden noch"-Töpfe.
// Aggregiert: Supplier-Purchases, Refunds, Agent-Settlements, Consignor-Payouts,
// Pending-Expenses, We-Borrow-Loans. Live-Berechnung pro loadPayables()-Call.
import { create } from 'zustand';
import { query, getSetting } from '@/core/db/helpers';

export type PayableType = 'refund' | 'supplier' | 'agent' | 'consignor' | 'expense' | 'loan';
export type AgeBucket = 'current' | '1-30' | '31-60' | '60+';

export interface PayableRow {
  id: string;                    // `${type}:${sourceId}` — stable React key
  type: PayableType;
  sourceTable: string;
  sourceId: string;
  counterpartyId?: string;
  counterpartyName: string;
  counterpartyHref?: string;     // optional Counterparty-Detail-Link (Customer/Supplier/Agent)
  referenceNumber: string;
  issuedAt: string;
  dueAt?: string;                // explizites Fälligkeitsdatum, sonst issuedAt + grace
  totalAmount: number;
  paidAmount: number;
  outstanding: number;
  daysOverdue: number;           // <0 = noch nicht fällig, 0 = heute fällig, >0 = überfällig
  ageBucket: AgeBucket;
  navigateTo?: string;           // Route auf Klick (Detail/List der Quelle)
  detailLabel: string;           // Sub-Label unter dem Typ (z.B. „Sales return")
}

interface PayablesStore {
  payables: PayableRow[];
  loading: boolean;
  loadPayables: () => void;
}

const DAY_MS = 86_400_000;

function dayDiff(fromIso: string, today: Date): number {
  const t = new Date(fromIso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((today.getTime() - t) / DAY_MS);
}

function bucket(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  return '60+';
}

interface BuildArgs {
  type: PayableType;
  sourceTable: string;
  sourceId: string;
  counterpartyId?: string;
  counterpartyName: string;
  counterpartyHref?: string;
  referenceNumber: string;
  issuedAt: string;
  dueAt?: string;
  totalAmount: number;
  paidAmount: number;
  navigateTo?: string;
  detailLabel: string;
}

function build(a: BuildArgs, today: Date, gracePeriodDays: number): PayableRow {
  const outstanding = Math.max(0, a.totalAmount - a.paidAmount);
  const dueRef = a.dueAt
    ? a.dueAt
    : new Date(new Date(a.issuedAt).getTime() + gracePeriodDays * DAY_MS).toISOString();
  const daysOverdue = dayDiff(dueRef, today);
  return {
    id: `${a.type}:${a.sourceId}`,
    type: a.type,
    sourceTable: a.sourceTable,
    sourceId: a.sourceId,
    counterpartyId: a.counterpartyId,
    counterpartyName: a.counterpartyName,
    counterpartyHref: a.counterpartyHref,
    referenceNumber: a.referenceNumber,
    issuedAt: a.issuedAt,
    dueAt: a.dueAt,
    totalAmount: a.totalAmount,
    paidAmount: a.paidAmount,
    outstanding,
    daysOverdue,
    ageBucket: bucket(daysOverdue),
    navigateTo: a.navigateTo,
    detailLabel: a.detailLabel,
  };
}

export const usePayablesStore = create<PayablesStore>((set) => ({
  payables: [],
  loading: false,

  loadPayables: () => {
    try {
      const today = new Date();
      const gracePeriodDays = parseInt(getSetting('payables.grace_period_days', '30'), 10) || 30;
      const rows: PayableRow[] = [];

      // 1) Supplier purchases — wir schulden Lieferanten Geld
      const purchaseRows = query(
        `SELECT p.id, p.purchase_number, p.supplier_id, s.name AS supplier_name,
                p.total_amount, p.paid_amount, p.purchase_date, p.created_at
         FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.status IN ('UNPAID', 'PARTIALLY_PAID')
           AND p.total_amount > p.paid_amount`,
        []
      );
      for (const r of purchaseRows) {
        rows.push(build({
          type: 'supplier',
          sourceTable: 'purchases',
          sourceId: r.id as string,
          counterpartyId: r.supplier_id as string | undefined,
          counterpartyName: (r.supplier_name as string) || 'Unknown supplier',
          counterpartyHref: r.supplier_id ? `/suppliers/${r.supplier_id}` : undefined,
          referenceNumber: (r.purchase_number as string) || ((r.id as string) || '').slice(0, 8),
          issuedAt: (r.purchase_date as string) || (r.created_at as string),
          totalAmount: Number(r.total_amount || 0),
          paidAmount: Number(r.paid_amount || 0),
          navigateTo: `/purchases/${r.id}`,
          detailLabel: 'Supplier purchase',
        }, today, gracePeriodDays));
      }

      // 2) Refund Payables — Sales-Returns mit refund_amount > refund_paid_amount
      const returnRows = query(
        `SELECT r.id, r.return_number, r.invoice_id, r.customer_id,
                c.first_name, c.last_name,
                r.refund_amount, r.refund_paid_amount, r.return_date, r.created_at,
                cn.id AS cn_id
         FROM sales_returns r
         LEFT JOIN customers c ON c.id = r.customer_id
         LEFT JOIN credit_notes cn ON cn.sales_return_id = r.id
         WHERE r.refund_amount > COALESCE(r.refund_paid_amount, 0)
           AND r.status IN ('APPROVED', 'REFUNDED')`,
        []
      );
      for (const r of returnRows) {
        const fn = (r.first_name as string) || '';
        const ln = (r.last_name as string) || '';
        const customerName = `${fn} ${ln}`.trim() || 'Unknown customer';
        rows.push(build({
          type: 'refund',
          sourceTable: 'sales_returns',
          sourceId: r.id as string,
          counterpartyId: r.customer_id as string | undefined,
          counterpartyName: customerName,
          counterpartyHref: r.customer_id ? `/clients/${r.customer_id}` : undefined,
          referenceNumber: (r.return_number as string) || ((r.id as string) || '').slice(0, 8),
          issuedAt: (r.return_date as string) || (r.created_at as string),
          totalAmount: Number(r.refund_amount || 0),
          paidAmount: Number(r.refund_paid_amount || 0),
          navigateTo: r.cn_id ? `/credit-notes/${r.cn_id}` : `/invoices/${r.invoice_id}`,
          detailLabel: 'Customer refund',
        }, today, gracePeriodDays));
      }

      // 3) Agent Settlement Payables — verkaufte Transfers, Provision noch nicht voll bezahlt
      const agentRows = query(
        `SELECT t.id, t.transfer_number, t.agent_id, a.name AS agent_name,
                t.settlement_amount, t.settlement_paid_amount, t.sold_at, t.created_at
         FROM agent_transfers t
         LEFT JOIN agents a ON a.id = t.agent_id
         WHERE t.status = 'sold'
           AND COALESCE(t.settlement_amount, 0) > COALESCE(t.settlement_paid_amount, 0)`,
        []
      );
      for (const r of agentRows) {
        rows.push(build({
          type: 'agent',
          sourceTable: 'agent_transfers',
          sourceId: r.id as string,
          counterpartyId: r.agent_id as string | undefined,
          counterpartyName: (r.agent_name as string) || 'Unknown agent',
          counterpartyHref: '/agents',
          referenceNumber: (r.transfer_number as string) || ((r.id as string) || '').slice(0, 8),
          issuedAt: (r.sold_at as string) || (r.created_at as string),
          totalAmount: Number(r.settlement_amount || 0),
          paidAmount: Number(r.settlement_paid_amount || 0),
          navigateTo: '/agents',
          detailLabel: 'Agent settlement',
        }, today, gracePeriodDays));
      }

      // 4) Consignor Payouts — verkauft, Eigentümer noch nicht voll ausgezahlt
      const consignmentRows = query(
        `SELECT cs.id, cs.consignment_number, cs.consignor_id,
                c.first_name, c.last_name,
                cs.payout_amount, cs.payout_paid_amount, cs.agreement_date, cs.created_at, cs.payout_date
         FROM consignments cs
         LEFT JOIN customers c ON c.id = cs.consignor_id
         WHERE (cs.status = 'sold' OR cs.status = 'SOLD')
           AND COALESCE(cs.payout_amount, 0) > COALESCE(cs.payout_paid_amount, 0)`,
        []
      );
      for (const r of consignmentRows) {
        const fn = (r.first_name as string) || '';
        const ln = (r.last_name as string) || '';
        const ownerName = `${fn} ${ln}`.trim() || 'Unknown consignor';
        rows.push(build({
          type: 'consignor',
          sourceTable: 'consignments',
          sourceId: r.id as string,
          counterpartyId: r.consignor_id as string | undefined,
          counterpartyName: ownerName,
          counterpartyHref: r.consignor_id ? `/clients/${r.consignor_id}` : undefined,
          referenceNumber: (r.consignment_number as string) || ((r.id as string) || '').slice(0, 8),
          issuedAt: (r.agreement_date as string) || (r.created_at as string),
          totalAmount: Number(r.payout_amount || 0),
          paidAmount: Number(r.payout_paid_amount || 0),
          navigateTo: `/consignments/${r.id}`,
          detailLabel: 'Consignor payout',
        }, today, gracePeriodDays));
      }

      // 5) Open Expenses — alles wo paid_amount < amount (Pay-Later + Partial Payment)
      const expenseRows = query(
        `SELECT id, expense_number, category, amount, paid_amount, expense_date, description, created_at
         FROM expenses
         WHERE status != 'CANCELLED' AND amount > COALESCE(paid_amount, 0) + 0.005`,
        []
      );
      for (const r of expenseRows) {
        const cat = (r.category as string) || 'Expense';
        const desc = (r.description as string) || '';
        rows.push(build({
          type: 'expense',
          sourceTable: 'expenses',
          sourceId: r.id as string,
          counterpartyName: desc || cat,
          referenceNumber: (r.expense_number as string) || ((r.id as string) || '').slice(0, 8),
          issuedAt: (r.expense_date as string) || (r.created_at as string),
          totalAmount: Number(r.amount || 0),
          paidAmount: Number(r.paid_amount || 0),
          navigateTo: '/expenses',
          detailLabel: `Expense · ${cat}`,
        }, today, gracePeriodDays));
      }

      // 6) We-Borrow Loans — Kunde/Dritter hat uns Geld geliehen
      const loanRows = query(
        `SELECT d.id, d.loan_number, d.counterparty, d.customer_id, d.amount, d.due_date, d.created_at,
                COALESCE((SELECT SUM(amount) FROM debt_payments WHERE debt_id = d.id), 0) AS paid
         FROM debts d
         WHERE d.direction = 'we_borrow'
           AND d.status NOT IN ('CANCELLED', 'REPAID', 'settled')`,
        []
      );
      for (const r of loanRows) {
        const total = Number(r.amount || 0);
        const paid = Number(r.paid || 0);
        if (total <= paid) continue;
        rows.push(build({
          type: 'loan',
          sourceTable: 'debts',
          sourceId: r.id as string,
          counterpartyId: r.customer_id as string | undefined,
          counterpartyName: (r.counterparty as string) || 'Unknown',
          counterpartyHref: r.customer_id ? `/clients/${r.customer_id}` : undefined,
          referenceNumber: (r.loan_number as string) || ((r.id as string) || '').slice(0, 8),
          issuedAt: r.created_at as string,
          dueAt: (r.due_date as string) || undefined,
          totalAmount: total,
          paidAmount: paid,
          navigateTo: '/debts',
          detailLabel: 'Borrowed loan',
        }, today, gracePeriodDays));
      }

      // Sortierung: am ältesten zuerst, dann größter offener Betrag.
      rows.sort((a, b) => {
        if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
        return b.outstanding - a.outstanding;
      });

      set({ payables: rows, loading: false });
    } catch (e) {
      console.warn('[payablesStore] loadPayables failed:', e);
      set({ payables: [], loading: false });
    }
  },
}));

// ── Selector helpers (in Komponenten verwendbar) ────────────────────────────

export function payablesTotal(rows: PayableRow[]): number {
  return rows.reduce((s, r) => s + r.outstanding, 0);
}
export function overdueCount(rows: PayableRow[]): number {
  return rows.filter(r => r.daysOverdue > 0).length;
}
export function bucketTotals(rows: PayableRow[]): Record<AgeBucket, { total: number; count: number }> {
  const b: Record<AgeBucket, { total: number; count: number }> = {
    'current': { total: 0, count: 0 },
    '1-30':    { total: 0, count: 0 },
    '31-60':   { total: 0, count: 0 },
    '60+':     { total: 0, count: 0 },
  };
  for (const r of rows) {
    b[r.ageBucket].total += r.outstanding;
    b[r.ageBucket].count += 1;
  }
  return b;
}

export const PAYABLE_TYPE_LABELS: Record<PayableType, string> = {
  refund:    'Refund',
  supplier:  'Supplier',
  agent:     'Agent',
  consignor: 'Consignor',
  expense:   'Expense',
  loan:      'Loan',
};

export const PAYABLE_TYPE_COLORS: Record<PayableType, { fg: string; bg: string }> = {
  refund:    { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)'  },
  supplier:  { fg: '#3D7FFF', bg: 'rgba(61,127,255,0.10)'  },
  agent:     { fg: '#715DE3', bg: 'rgba(113,93,227,0.10)'  },
  consignor: { fg: '#EC4899', bg: 'rgba(236,72,153,0.10)'  },
  expense:   { fg: '#0EA5C5', bg: 'rgba(14,165,197,0.10)'  },
  loan:      { fg: '#DC2626', bg: 'rgba(220,38,38,0.10)'   },
};
