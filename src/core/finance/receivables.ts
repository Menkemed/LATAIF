// ═══════════════════════════════════════════════════════════
// LATAIF — Receivables Breakdown
// Pro offene Forderung eine Zeile mit Source, Referenz, Open, Due, Aging.
// 4 kommerzielle Sources: INVOICE, CONSIGNMENT, APPROVAL, REPAIR.
// Private Bargeld-Loans (debts/we_lend) sind bewusst NICHT enthalten — die haben
// eine eigene Dashboard-Section "Private Loans" + die /debts Seite. Mischen wuerde
// dort doppelt zaehlen.
// Spiegelbild zu payablesStore — gleiche Bucket-Logik (current/1-30/31-60/60+).
// ═══════════════════════════════════════════════════════════

import { query } from '@/core/db/helpers';

export type ReceivableSource = 'INVOICE' | 'CONSIGNMENT' | 'APPROVAL' | 'REPAIR';

export type ReceivableAgeBucket = 'current' | '1-30' | '31-60' | '60+';

export interface ReceivableRow {
  id: string;                      // unique key (source + sourceId)
  customerId: string;
  customerName: string;
  source: ReceivableSource;
  sourceId: string;                // invoice_id / consignment_id / agent_transfer_id / repair_id
  reference: string;               // invoice_number / consignment_number / transfer_number / repair_number
  detailLabel: string;             // kurzer Sub-Text unter Type-Pill (z.B. "Approval transfer")
  invoiceId: string | null;
  totalAmount: number;             // ursprüngliche Forderung
  paidAmount: number;              // bereits gezahlt
  open: number;                    // = totalAmount - paidAmount
  issuedAt: string;
  dueAt: string | null;
  daysOverdue: number;             // > 0 = überfällig, 0 = heute fällig, < 0 = noch Frist
  navigateTo: string;
}

function customerLabel(firstName?: string, lastName?: string, company?: string): string {
  const fn = (firstName || '').trim();
  const ln = (lastName || '').trim();
  const full = `${fn} ${ln}`.trim();
  if (full && company) return `${full} (${company})`;
  return full || company || '—';
}

function dayDiff(fromIso: string, toIso: string): number {
  const a = new Date(fromIso); const b = new Date(toIso);
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

function computeDaysOverdue(dueAt: string | null, issuedAt: string, graceDays = 0): number {
  const today = new Date().toISOString();
  if (dueAt) return dayDiff(today, dueAt);
  if (!issuedAt) return 0;
  // Fallback: issuedAt + graceDays (Default 0 → Aging beginnt sofort).
  const d = new Date(issuedAt); d.setUTCDate(d.getUTCDate() + graceDays);
  return dayDiff(today, d.toISOString());
}

export function receivablesBreakdown(): ReceivableRow[] {
  const rows: ReceivableRow[] = [];

  // ── 1. Consignment-Auto-Invoices ─────────────────────────────
  const consRows = query(
    `SELECT cs.id          AS cs_id,
            cs.consignment_number AS cs_number,
            i.id           AS inv_id,
            i.customer_id  AS customer_id,
            c.first_name   AS first_name,
            c.last_name    AS last_name,
            c.company      AS company,
            i.gross_amount AS gross,
            i.paid_amount  AS paid,
            COALESCE(cn.cancel_amount, 0) AS cn_cancel,
            i.issued_at    AS issued_at,
            i.due_at       AS due_at
       FROM consignments cs
       JOIN invoices i  ON i.id = cs.invoice_id
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN (
         SELECT invoice_id, SUM(receivable_cancel_amount) AS cancel_amount
         FROM credit_notes GROUP BY invoice_id
       ) cn ON cn.invoice_id = i.id
      WHERE cs.invoice_id IS NOT NULL
        AND i.status NOT IN ('CANCELLED', 'DRAFT', 'RETURNED')
        AND (i.gross_amount - i.paid_amount - COALESCE(cn.cancel_amount, 0)) > 0.005`
  );
  for (const r of consRows) {
    const total = (Number(r.gross) || 0) - (Number(r.cn_cancel) || 0);
    const paid  = Number(r.paid) || 0;
    const open  = Math.max(0, total - paid);
    const issuedAt = (r.issued_at as string) || '';
    const dueAt = (r.due_at as string) || null;
    rows.push({
      id:           `CONSIGNMENT-${r.cs_id}`,
      customerId:   r.customer_id as string,
      customerName: customerLabel(r.first_name as string, r.last_name as string, r.company as string),
      source:       'CONSIGNMENT',
      sourceId:     r.cs_id as string,
      reference:    (r.cs_number as string) || (r.inv_id as string),
      detailLabel:  'Consignment sale',
      invoiceId:    r.inv_id as string,
      totalAmount:  total,
      paidAmount:   paid,
      open,
      issuedAt,
      dueAt,
      daysOverdue:  computeDaysOverdue(dueAt, issuedAt),
      navigateTo:   `/consignments/${r.cs_id}`,
    });
  }

  // ── 2. Regular Invoices (ohne Consignment-Bindung) ───────────
  const invRows = query(
    `SELECT i.id            AS inv_id,
            i.invoice_number AS inv_number,
            i.customer_id   AS customer_id,
            c.first_name    AS first_name,
            c.last_name     AS last_name,
            c.company       AS company,
            i.gross_amount  AS gross,
            i.paid_amount   AS paid,
            COALESCE(cn.cancel_amount, 0) AS cn_cancel,
            i.issued_at     AS issued_at,
            i.due_at        AS due_at
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN (
         SELECT invoice_id, SUM(receivable_cancel_amount) AS cancel_amount
         FROM credit_notes GROUP BY invoice_id
       ) cn ON cn.invoice_id = i.id
       LEFT JOIN consignments cs ON cs.invoice_id = i.id
      WHERE cs.id IS NULL
        AND i.status NOT IN ('CANCELLED', 'DRAFT', 'RETURNED')
        AND (i.gross_amount - i.paid_amount - COALESCE(cn.cancel_amount, 0)) > 0.005`
  );
  for (const r of invRows) {
    const total = (Number(r.gross) || 0) - (Number(r.cn_cancel) || 0);
    const paid  = Number(r.paid) || 0;
    const open  = Math.max(0, total - paid);
    const issuedAt = (r.issued_at as string) || '';
    const dueAt = (r.due_at as string) || null;
    rows.push({
      id:           `INVOICE-${r.inv_id}`,
      customerId:   r.customer_id as string,
      customerName: customerLabel(r.first_name as string, r.last_name as string, r.company as string),
      source:       'INVOICE',
      sourceId:     r.inv_id as string,
      reference:    (r.inv_number as string) || (r.inv_id as string),
      detailLabel:  paid > 0 ? 'Partial invoice' : 'Open invoice',
      invoiceId:    r.inv_id as string,
      totalAmount:  total,
      paidAmount:   paid,
      open,
      issuedAt,
      dueAt,
      daysOverdue:  computeDaysOverdue(dueAt, issuedAt),
      navigateTo:   `/invoices/${r.inv_id}`,
    });
  }

  // ── 3. Approval-Sold ohne Invoice ────────────────────────────
  // Due-Date: agent_transfers.return_by — der Tag bis zu dem der Agent
  // verkauft oder zurückbringen muss. Nach sold ist das die de-facto
  // Settlement-Frist.
  const aprRows = query(
    `SELECT at.id              AS at_id,
            at.transfer_number AS at_number,
            at.agent_id        AS agent_id,
            ag.customer_id     AS customer_id,
            c.first_name       AS first_name,
            c.last_name        AS last_name,
            c.company          AS company,
            COALESCE(at.settlement_amount, 0)       AS settle_total,
            COALESCE(at.settlement_paid_amount, 0)  AS settle_paid,
            at.sold_at         AS sold_at,
            at.transferred_at  AS transferred_at,
            at.return_by       AS return_by
       FROM agent_transfers at
       JOIN agents ag    ON ag.id = at.agent_id
       JOIN customers c  ON c.id = ag.customer_id
      WHERE at.invoice_id IS NULL
        AND at.status IN ('sold', 'settled')
        AND (COALESCE(at.settlement_amount, 0) - COALESCE(at.settlement_paid_amount, 0)) > 0.005`
  );
  for (const r of aprRows) {
    const total = Number(r.settle_total) || 0;
    const paid  = Number(r.settle_paid) || 0;
    const open  = Math.max(0, total - paid);
    const issuedAt = (r.sold_at as string) || (r.transferred_at as string) || '';
    const dueAt = (r.return_by as string) || null;
    rows.push({
      id:           `APPROVAL-${r.at_id}`,
      customerId:   r.customer_id as string,
      customerName: customerLabel(r.first_name as string, r.last_name as string, r.company as string),
      source:       'APPROVAL',
      sourceId:     r.at_id as string,
      reference:    (r.at_number as string) || (r.at_id as string),
      detailLabel:  'Approval transfer',
      invoiceId:    null,
      totalAmount:  total,
      paidAmount:   paid,
      open,
      issuedAt,
      dueAt,
      daysOverdue:  computeDaysOverdue(dueAt, issuedAt),
      navigateTo:   `/agents/${r.agent_id}`,
    });
  }

  // ── 4. Offene Repairs ────────────────────────────────────────
  // Due-Date-Fallback: estimated_ready (geschätztes Fertigstellungs-Datum).
  // Repairs ohne Estimate aging gegen completed_at.
  const repRows = query(
    `SELECT r.id              AS rep_id,
            r.repair_number   AS rep_number,
            r.customer_id     AS customer_id,
            c.first_name      AS first_name,
            c.last_name       AS last_name,
            c.company         AS company,
            COALESCE(r.charge_to_customer, 0) AS charge,
            COALESCE(r.customer_paid_amount, 0) AS paid,
            r.completed_at    AS completed_at,
            r.received_at     AS received_at,
            r.estimated_ready AS estimated_ready,
            r.status          AS status
       FROM repairs r
       JOIN customers c ON c.id = r.customer_id
      WHERE r.invoice_id IS NULL
        AND r.status IN ('ready', 'picked_up')
        AND COALESCE(r.charge_to_customer, 0) > 0
        AND (COALESCE(r.charge_to_customer, 0) - COALESCE(r.customer_paid_amount, 0)) > 0.005`
  );
  for (const r of repRows) {
    const total = Number(r.charge) || 0;
    const paid  = Number(r.paid) || 0;
    const open  = Math.max(0, total - paid);
    const issuedAt = (r.completed_at as string) || (r.received_at as string) || '';
    const dueAt = (r.estimated_ready as string) || null;
    const repStatus = (r.status as string) === 'picked_up' ? 'Picked up · unpaid' : 'Ready · unpaid';
    rows.push({
      id:           `REPAIR-${r.rep_id}`,
      customerId:   r.customer_id as string,
      customerName: customerLabel(r.first_name as string, r.last_name as string, r.company as string),
      source:       'REPAIR',
      sourceId:     r.rep_id as string,
      reference:    (r.rep_number as string) || (r.rep_id as string),
      detailLabel:  repStatus,
      invoiceId:    null,
      totalAmount:  total,
      paidAmount:   paid,
      open,
      issuedAt,
      dueAt,
      daysOverdue:  computeDaysOverdue(dueAt, issuedAt),
      navigateTo:   `/repairs/${r.rep_id}`,
    });
  }

  // (frueher Sektion 5: Loans we_lend/MONEY_GIVEN) — ENTFERNT.
  // Grund: Loans sind Bargeld-Darlehen ausserhalb des Handels und haben jetzt ihre
  // eigene Dashboard-Section "Private Loans" + die /debts Seite. Inkludierung hier
  // fuehrte zu Doppelzaehlung mit der dortigen Card "LOANS GIVEN".
  // Falls sie spaeter wieder zusammen aggregiert werden sollen, einen separaten
  // Helper (z.B. allOutstandingFromCustomers()) bauen, nicht hier mischen.

  // Sortierung: am stärksten überfällig zuerst, dann nach Open desc.
  rows.sort((a, b) => {
    if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
    return b.open - a.open;
  });
  return rows;
}

// ── Aging-Helpers ─────────────────────────────────────────────

export function bucketFor(daysOverdue: number): ReceivableAgeBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  return '60+';
}

export function bucketTotals(rows: ReceivableRow[]): Record<ReceivableAgeBucket, { total: number; count: number }> {
  const out: Record<ReceivableAgeBucket, { total: number; count: number }> = {
    'current': { total: 0, count: 0 },
    '1-30':    { total: 0, count: 0 },
    '31-60':   { total: 0, count: 0 },
    '60+':     { total: 0, count: 0 },
  };
  for (const r of rows) {
    const b = bucketFor(r.daysOverdue);
    out[b].total += r.open;
    out[b].count++;
  }
  return out;
}

export function overdueCount(rows: ReceivableRow[]): number {
  return rows.reduce((n, r) => n + (r.daysOverdue > 0 ? 1 : 0), 0);
}

export function receivablesTotal(rows: ReceivableRow[]): number {
  return rows.reduce((s, r) => s + r.open, 0);
}

// ── Summary für Dashboard ─────────────────────────────────────

export interface ReceivableSummary {
  total: number;
  rowCount: number;
  clientCount: number;
  sources: ReceivableSource[];   // sortiert: am häufigsten zuerst
}

export function receivablesSummary(): ReceivableSummary {
  const rows = receivablesBreakdown();
  const total = rows.reduce((s, r) => s + r.open, 0);
  const clientSet = new Set(rows.map(r => r.customerId).filter(Boolean));
  const counts: Record<ReceivableSource, number> = { INVOICE: 0, CONSIGNMENT: 0, APPROVAL: 0, REPAIR: 0 };
  for (const r of rows) counts[r.source]++;
  const sources = (Object.keys(counts) as ReceivableSource[])
    .filter(s => counts[s] > 0)
    .sort((a, b) => counts[b] - counts[a]);
  return { total, rowCount: rows.length, clientCount: clientSet.size, sources };
}

// ── Source-Labels & Colors (zentral, von Page genutzt) ────────

export const RECEIVABLE_SOURCE_LABELS: Record<ReceivableSource, string> = {
  INVOICE:     'Invoice',
  CONSIGNMENT: 'Consignment',
  APPROVAL:    'Approval',
  REPAIR:      'Repair',
};

export const RECEIVABLE_SOURCE_COLORS: Record<ReceivableSource, { fg: string; bg: string }> = {
  INVOICE:     { fg: '#3D7FFF', bg: 'rgba(61,127,255,0.10)' },
  CONSIGNMENT: { fg: '#7C3AED', bg: 'rgba(124,58,237,0.10)' },
  APPROVAL:    { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)' },
  REPAIR:      { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
};
