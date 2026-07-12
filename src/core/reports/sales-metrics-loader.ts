// M-01 — geteilter SQL-Loader fuer computeSalesMetrics/-ByCustomer.
// Extrahiert aus context.ts (M-13), damit headless-Aufrufer (Exec-Summary),
// getCustomerStats und die Kunden-Anzeigen (Top Clients, Analytics CLIENTS)
// dieselbe Datenbeschaffung nutzen: FINAL-Invoices MIT Lines (→ VAT_10 korrekt)
// + alle zugehoerigen Returns als Minimal-Objekte.
//
// Filter sind optional und rein einschraenkend:
//  - branchId:   invoices.branch_id (Returns folgen ueber den Invoice-JOIN)
//  - customerId: invoices.customer_id (per-Kunde-Sicht, z.B. getCustomerStats)
//  - startISO/endISO: COALESCE(issued_at, created_at) >= start AND < end
//    (endISO EXKLUSIV, wie ReportPeriod) — nur auf Invoices; Returns werden
//    bewusst NICHT zeitgefiltert (Invoice-Period-Semantik: der Return folgt seiner
//    Rechnung, B3-B — der finalIds-Guard in computeSalesMetrics entscheidet).
// Ohne Zeitfenster = All-Time (computeSalesMetrics dann ohne period aufrufen).

import { query } from '@/core/db/helpers';
import type { SalesMetricsInvoice, SalesMetricsReturn } from '@/core/reports/sales-metrics';

export interface SalesDataFilter {
  branchId?: string;
  customerId?: string;
  startISO?: string;   // inklusiv
  endISO?: string;     // exklusiv
}

export interface LoadedSalesData {
  invoices: Array<SalesMetricsInvoice & { customerId?: string }>;
  salesReturns: SalesMetricsReturn[];
}

export function loadSalesData(filter: SalesDataFilter): LoadedSalesData {
  const conds: string[] = [`i.status = 'FINAL'`];
  const params: unknown[] = [];
  if (filter.branchId) { conds.push('i.branch_id = ?'); params.push(filter.branchId); }
  if (filter.customerId) { conds.push('i.customer_id = ?'); params.push(filter.customerId); }
  if (filter.startISO) { conds.push('COALESCE(i.issued_at, i.created_at) >= ?'); params.push(filter.startISO); }
  if (filter.endISO) { conds.push('COALESCE(i.issued_at, i.created_at) < ?'); params.push(filter.endISO); }
  const where = conds.join(' AND ');

  const invRows = query(
    `SELECT i.id, i.customer_id, i.status, i.gross_amount, i.net_amount,
            i.margin_snapshot, i.purchase_price_snapshot, i.issued_at, i.created_at
       FROM invoices i
      WHERE ${where}`,
    params
  );
  const lineRows = query(
    `SELECT il.invoice_id, il.tax_scheme, il.vat_amount
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE ${where}`,
    params
  );
  const linesByInv = new Map<string, { taxScheme: string; vatAmount: number }[]>();
  for (const lr of lineRows) {
    const iid = String(lr.invoice_id);
    const arr = linesByInv.get(iid) || [];
    arr.push({ taxScheme: String(lr.tax_scheme || ''), vatAmount: Number(lr.vat_amount) || 0 });
    linesByInv.set(iid, arr);
  }
  const invoices = invRows.map(r => ({
    id: String(r.id),
    customerId: (r.customer_id as string) || undefined,
    status: String(r.status),
    grossAmount: Number(r.gross_amount) || 0,
    netAmount: Number(r.net_amount) || 0,
    marginSnapshot: Number(r.margin_snapshot) || 0,
    purchasePriceSnapshot: Number(r.purchase_price_snapshot) || 0,
    issuedAt: (r.issued_at as string) || undefined,
    createdAt: (r.created_at as string) || undefined,
    lines: linesByInv.get(String(r.id)) || [],
  }));

  // Returns ueber den Invoice-JOIN auf dieselbe Menge eingrenzen (branch/customer),
  // aber OHNE Zeitfenster — der finalIds-Guard + die Return-Status-Regel (B3) in
  // computeSalesMetrics entscheiden, was zaehlt: ein wirksamer Return restated die
  // Periode SEINER Rechnung (Invoice-Period-Semantik, B3-B; kein Return-Datumsfilter).
  const retConds: string[] = ['1=1'];
  const retParams: unknown[] = [];
  if (filter.branchId) { retConds.push('r.branch_id = ?'); retParams.push(filter.branchId); }
  if (filter.customerId) { retConds.push('i.customer_id = ?'); retParams.push(filter.customerId); }
  const retRows = query(
    `SELECT r.invoice_id, r.status, r.total_amount, r.refund_paid_amount, r.refund_paid_date, r.return_date
       FROM sales_returns r JOIN invoices i ON i.id = r.invoice_id
      WHERE ${retConds.join(' AND ')}`,
    retParams
  );
  const salesReturns = retRows.map(r => ({
    invoiceId: String(r.invoice_id),
    status: String(r.status || ''),
    totalAmount: Number(r.total_amount) || 0,
    refundPaidAmount: Number(r.refund_paid_amount) || 0,
    refundPaidDate: (r.refund_paid_date as string) || undefined,
    returnDate: (r.return_date as string) || undefined,
  }));

  return { invoices, salesReturns };
}
