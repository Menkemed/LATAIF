// ═══════════════════════════════════════════════════════════
// LATAIF — Report Context Builder
// Extracts structured KPI snapshots from the DB for a period,
// re-used by Executive Summary, Custom Reports, Chat and Alerts.
// ═══════════════════════════════════════════════════════════

import { query } from '@/core/db/helpers';
import { computeSalesMetrics, type SalesMetrics } from '@/core/reports/sales-metrics';
import { canonicalLoanDirection } from '@/core/models/types';

// ── Period helpers ──────────────────────────────────────────

export interface ReportPeriod {
  label: string;          // human readable, e.g. "Q1 2026", "April 2026"
  startISO: string;       // inclusive
  endISO: string;         // exclusive (next-day 00:00)
  granularity: 'month' | 'quarter' | 'year' | 'custom';
}

export function periodForMonth(year: number, month: number): ReportPeriod {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    label: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    granularity: 'month',
  };
}

export function periodForQuarter(year: number, q: number): ReportPeriod {
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 1));
  return {
    label: `Q${q} ${year}`,
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    granularity: 'quarter',
  };
}

export function periodForYear(year: number): ReportPeriod {
  return {
    label: `${year}`,
    startISO: new Date(Date.UTC(year, 0, 1)).toISOString(),
    endISO: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
    granularity: 'year',
  };
}

export function previousPeriodOf(p: ReportPeriod): ReportPeriod {
  const start = new Date(p.startISO);
  const end = new Date(p.endISO);
  const span = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - span);
  const prevEnd = start;
  return {
    label: `Previous ${p.granularity}`,
    startISO: prevStart.toISOString(),
    endISO: prevEnd.toISOString(),
    granularity: p.granularity,
  };
}

// ── Shape ───────────────────────────────────────────────────

export interface ReportContext {
  period: ReportPeriod;
  generatedAt: string;
  branchId: string;
  currency: string;

  revenue: {
    grossRevenue: number;
    netRevenue: number;
    vat: number;
    profit: number;
    marginPct: number;
    invoiceCount: number;
    avgInvoiceValue: number;
  };

  cashflow: {
    cashReceived: number;
    bankReceived: number;
    cardReceived: number;
    cardFeesLost: number;
    taxPaid: number;
    netInflow: number;
  };

  stock: {
    totalItems: number;
    totalPurchaseValue: number;
    totalPlannedSaleValue: number;
    avgDaysInStock: number;
    slowMovers: Array<{ id: string; brand: string; name: string; daysInStock: number; purchasePrice: number }>;
    byCategory: Array<{ category: string; count: number; purchaseValue: number }>;
  };

  sales: {
    byBrand: Array<{ brand: string; units: number; revenue: number; profit: number }>;
    byCategory: Array<{ category: string; units: number; revenue: number; profit: number }>;
    topProducts: Array<{ brand: string; name: string; salePrice: number; profit: number }>;
  };

  customers: {
    active: number;
    dormant: number;
    newInPeriod: number;
    topByRevenue: Array<{ name: string; revenue: number; purchaseCount: number }>;
    inactiveVips: Array<{ name: string; vipLevel: number; lastPurchaseAt: string | null; daysSinceContact: number }>;
  };

  operations: {
    openRepairs: number;
    openOrders: number;
    overdueInvoices: number;
    overdueAmount: number;
    openConsignments: number;
    activeConsignmentValue: number;
  };

  debts: {
    owedToUs: number;
    weOwe: number;
  };

  previousPeriod?: {
    grossRevenue: number;
    profit: number;
    invoiceCount: number;
  };
}

// ── Main builder ────────────────────────────────────────────

function num(row: Record<string, unknown> | undefined, key: string): number {
  return (row?.[key] as number) || 0;
}

function firstRow(sql: string, params: unknown[]): Record<string, unknown> | undefined {
  try { return query(sql, params)[0]; } catch { return undefined; }
}

function rows(sql: string, params: unknown[]): Record<string, unknown>[] {
  try { return query(sql, params); } catch { return []; }
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export interface BuildOpts {
  branchId: string;
  period: ReportPeriod;
  withPreviousPeriod?: boolean;
  currency?: string;
}

// M-13 — laedt FINAL-Rechnungen + Lines + Returns einer Periode als Minimal-Objekte
// und delegiert an den zentralen SSOT computeSalesMetrics. context.ts ist headless
// (reines SQL), daher der lokale Datenabruf hier; die Umsatzregel (FINAL-only, Refunds
// anteilig ab, VAT nur VAT_10) lebt EINMAL in sales-metrics.ts.
// endISO ist exklusiv (< endISO); computeSalesMetrics ist inklusiv (<= to) -> wir
// uebergeben endISO-1ms als inklusive Obergrenze (auch fuer das Refund-Datum korrekt).
function loadSalesMetrics(branchId: string, startISO: string, endISO: string): SalesMetrics {
  const invRows = query(
    `SELECT id, status, gross_amount, net_amount, margin_snapshot, purchase_price_snapshot, issued_at, created_at
       FROM invoices
      WHERE branch_id = ? AND status = 'FINAL'
        AND COALESCE(issued_at, created_at) >= ? AND COALESCE(issued_at, created_at) < ?`,
    [branchId, startISO, endISO]
  );
  const lineRows = query(
    `SELECT il.invoice_id, il.tax_scheme, il.vat_amount
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.branch_id = ? AND i.status = 'FINAL'
        AND COALESCE(i.issued_at, i.created_at) >= ? AND COALESCE(i.issued_at, i.created_at) < ?`,
    [branchId, startISO, endISO]
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
    status: String(r.status),
    grossAmount: Number(r.gross_amount) || 0,
    netAmount: Number(r.net_amount) || 0,
    marginSnapshot: Number(r.margin_snapshot) || 0,
    purchasePriceSnapshot: Number(r.purchase_price_snapshot) || 0,
    issuedAt: (r.issued_at as string) || undefined,
    createdAt: (r.created_at as string) || undefined,
    lines: linesByInv.get(String(r.id)) || [],
  }));
  const retRows = query(
    `SELECT invoice_id, refund_paid_amount, refund_paid_date, return_date
       FROM sales_returns WHERE branch_id = ?`,
    [branchId]
  );
  const salesReturns = retRows.map(r => ({
    invoiceId: String(r.invoice_id),
    refundPaidAmount: Number(r.refund_paid_amount) || 0,
    refundPaidDate: (r.refund_paid_date as string) || undefined,
    returnDate: (r.return_date as string) || undefined,
  }));
  const toInclusive = new Date(new Date(endISO).getTime() - 1).toISOString();
  return computeSalesMetrics(invoices, salesReturns, { from: startISO, to: toInclusive });
}

export function buildReportContext(opts: BuildOpts): ReportContext {
  const { branchId, period } = opts;
  const { startISO, endISO } = period;

  // ── Revenue ── M-13: zentrale Umsatzregel via computeSalesMetrics (FINAL-only,
  // Refunds anteilig ab, VAT nur VAT_10). Vorher zaehlte hier FINAL+PARTIAL OHNE
  // Refund-Abzug → Exec-Summary wich von Dashboard/Sales-Report ab.
  const sales = loadSalesMetrics(branchId, startISO, endISO);
  const invoiceCount = sales.count;
  const grossRevenue = sales.gross;
  const netRevenue = sales.net;
  const vat = sales.vat;
  const profit = sales.profit;

  // ── Cashflow (period-scoped payments) ──────────────────
  const paymentRows = rows(
    `SELECT method, COALESCE(SUM(amount), 0) AS total
     FROM payments
     WHERE branch_id = ? AND received_at >= ? AND received_at < ?
     GROUP BY method`,
    [branchId, startISO, endISO]
  );
  let cashReceived = 0, bankReceived = 0, cardReceived = 0;
  for (const r of paymentRows) {
    const m = r.method as string;
    const amt = (r.total as number) || 0;
    if (m === 'cash') cashReceived += amt;
    else if (m === 'bank_transfer') bankReceived += amt;
    else if (m === 'card') cardReceived += amt;
  }
  // v0.7.26 — Brand-genaue Karten-Gebuehr: TATSAECHLICH gebuchte CardFees (Amex 2,5%
  // / Normal 2,2%) statt Pauschal-Schaetzung. Periodengenau ueber die zugehoerige
  // Zahlung (gemeinsamer created_at-Timestamp + invoice_id) auf received_at gefiltert,
  // damit die Gebuehr in derselben Periode wie ihr Brutto liegt. CANCELLED raus.
  const cardFeeRow = firstRow(
    `SELECT COALESCE(SUM(e.amount), 0) AS fee
       FROM expenses e
       JOIN payments p ON p.created_at = e.created_at AND p.invoice_id = e.related_entity_id
      WHERE e.branch_id = ? AND e.category = 'CardFees' AND e.status != 'CANCELLED'
        AND e.related_module = 'invoice'
        AND p.received_at >= ? AND p.received_at < ?`,
    [branchId, startISO, endISO]
  );
  const cardFeesLost = Math.round(num(cardFeeRow, 'fee') * 1000) / 1000;

  const taxPaidRow = firstRow(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM tax_payments
     WHERE branch_id = ? AND paid_at >= ? AND paid_at < ?`,
    [branchId, startISO, endISO]
  );
  const taxPaid = num(taxPaidRow, 'total');

  const netInflow = cashReceived + bankReceived + (cardReceived - cardFeesLost) - taxPaid;

  // ── Stock (live snapshot, not period-scoped) ───────────
  // Plan §Commission §5: nur OWN-Ware zählt als Asset.
  const stockRow = firstRow(
    `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(purchase_price), 0) AS purchase_value,
            COALESCE(SUM(planned_sale_price), 0) AS planned_sale_value,
            COALESCE(AVG(days_in_stock), 0) AS avg_days
     FROM products
     WHERE branch_id = ? AND stock_status = 'in_stock' AND source_type = 'OWN'`,
    [branchId]
  );
  const totalItems = num(stockRow, 'cnt');
  const totalPurchaseValue = num(stockRow, 'purchase_value');
  const totalPlannedSaleValue = num(stockRow, 'planned_sale_value');
  const avgDaysInStock = num(stockRow, 'avg_days');

  const slowMovers = rows(
    `SELECT id, brand, name, days_in_stock, purchase_price
     FROM products
     WHERE branch_id = ? AND stock_status = 'in_stock' AND source_type = 'OWN' AND days_in_stock > 180
     ORDER BY days_in_stock DESC LIMIT 10`,
    [branchId]
  ).map(r => ({
    id: r.id as string,
    brand: r.brand as string,
    name: r.name as string,
    daysInStock: num(r, 'days_in_stock'),
    purchasePrice: num(r, 'purchase_price'),
  }));

  const stockByCat = rows(
    `SELECT c.name AS category, COUNT(p.id) AS cnt, COALESCE(SUM(p.purchase_price), 0) AS val
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.branch_id = ? AND p.stock_status = 'in_stock' AND p.source_type = 'OWN'
     GROUP BY c.id ORDER BY val DESC`,
    [branchId]
  ).map(r => ({
    category: r.category as string,
    count: num(r, 'cnt'),
    purchaseValue: num(r, 'val'),
  }));

  // ── Sales breakdown (period-scoped) ────────────────────
  const salesByBrand = rows(
    `SELECT p.brand AS brand,
            COUNT(il.id) AS units,
            COALESCE(SUM(il.line_total), 0) AS revenue,
            COALESCE(SUM(il.line_total - il.purchase_price_snapshot * COALESCE(il.quantity, 1)), 0) AS profit
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     JOIN products p ON p.id = il.product_id
     WHERE i.branch_id = ? AND i.status != 'CANCELLED' AND i.status != 'DRAFT'
       AND COALESCE(i.issued_at, i.created_at) >= ? AND COALESCE(i.issued_at, i.created_at) < ?
     GROUP BY p.brand ORDER BY revenue DESC LIMIT 10`,
    [branchId, startISO, endISO]
  ).map(r => ({
    brand: r.brand as string,
    units: num(r, 'units'),
    revenue: num(r, 'revenue'),
    profit: num(r, 'profit'),
  }));

  const salesByCategory = rows(
    `SELECT c.name AS category,
            COUNT(il.id) AS units,
            COALESCE(SUM(il.line_total), 0) AS revenue,
            COALESCE(SUM(il.line_total - il.purchase_price_snapshot * COALESCE(il.quantity, 1)), 0) AS profit
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     JOIN products p ON p.id = il.product_id
     JOIN categories c ON c.id = p.category_id
     WHERE i.branch_id = ? AND i.status != 'CANCELLED' AND i.status != 'DRAFT'
       AND COALESCE(i.issued_at, i.created_at) >= ? AND COALESCE(i.issued_at, i.created_at) < ?
     GROUP BY c.id ORDER BY revenue DESC`,
    [branchId, startISO, endISO]
  ).map(r => ({
    category: r.category as string,
    units: num(r, 'units'),
    revenue: num(r, 'revenue'),
    profit: num(r, 'profit'),
  }));

  const topProducts = rows(
    `SELECT p.brand AS brand, p.name AS name, il.line_total AS sale_price,
            (il.line_total - il.purchase_price_snapshot * COALESCE(il.quantity, 1)) AS profit
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     JOIN products p ON p.id = il.product_id
     WHERE i.branch_id = ? AND i.status != 'CANCELLED' AND i.status != 'DRAFT'
       AND COALESCE(i.issued_at, i.created_at) >= ? AND COALESCE(i.issued_at, i.created_at) < ?
     ORDER BY profit DESC LIMIT 5`,
    [branchId, startISO, endISO]
  ).map(r => ({
    brand: r.brand as string,
    name: r.name as string,
    salePrice: num(r, 'sale_price'),
    profit: num(r, 'profit'),
  }));

  // ── Customers ──────────────────────────────────────────
  const custSummary = firstRow(
    `SELECT
       SUM(CASE WHEN sales_stage = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN sales_stage = 'dormant' THEN 1 ELSE 0 END) AS dormant,
       SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS new_in_period
     FROM customers WHERE branch_id = ?`,
    [startISO, endISO, branchId]
  );

  const topCustomers = rows(
    `SELECT c.first_name || ' ' || c.last_name AS name,
            COALESCE(SUM(i.gross_amount), 0) AS revenue,
            COUNT(DISTINCT i.id) AS cnt
     FROM customers c LEFT JOIN invoices i
       ON i.customer_id = c.id
      AND i.status != 'CANCELLED' AND i.status != 'DRAFT'
      AND COALESCE(i.issued_at, i.created_at) >= ? AND COALESCE(i.issued_at, i.created_at) < ?
     WHERE c.branch_id = ?
     GROUP BY c.id HAVING revenue > 0
     ORDER BY revenue DESC LIMIT 5`,
    [startISO, endISO, branchId]
  ).map(r => ({
    name: r.name as string,
    revenue: num(r, 'revenue'),
    purchaseCount: num(r, 'cnt'),
  }));

  const nowISO = new Date().toISOString();
  const inactiveVips = rows(
    `SELECT first_name || ' ' || last_name AS name, vip_level, last_purchase_at, last_contact_at
     FROM customers
     WHERE branch_id = ? AND vip_level >= 1
       AND (last_contact_at IS NULL OR last_contact_at < ?)
     ORDER BY vip_level DESC, last_contact_at ASC LIMIT 10`,
    [branchId, new Date(Date.now() - 90 * 86400000).toISOString()]
  ).map(r => {
    const lastIso = (r.last_contact_at as string) || (r.last_purchase_at as string) || null;
    const days = lastIso ? Math.floor((Date.parse(nowISO) - Date.parse(lastIso)) / 86400000) : 999;
    return {
      name: r.name as string,
      vipLevel: num(r, 'vip_level'),
      lastPurchaseAt: (r.last_purchase_at as string) || null,
      daysSinceContact: days,
    };
  });

  // ── Operations ─────────────────────────────────────────
  const opsRepairs = firstRow(
    `SELECT COUNT(*) AS cnt FROM repairs WHERE branch_id = ? AND status NOT IN ('picked_up','cancelled')`,
    [branchId]
  );
  const opsOrders = firstRow(
    `SELECT COUNT(*) AS cnt FROM orders WHERE branch_id = ? AND status NOT IN ('completed','cancelled')`,
    [branchId]
  );
  const opsInvoicesOverdue = firstRow(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(gross_amount - paid_amount), 0) AS outstanding
     FROM invoices WHERE branch_id = ? AND status = 'PARTIAL'
       AND due_at IS NOT NULL AND due_at < ?`,
    [branchId, nowISO]
  );
  const opsConsignments = firstRow(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(agreed_price), 0) AS val
     FROM consignments WHERE branch_id = ? AND status = 'active'`,
    [branchId]
  );

  // ── Debts ── M-14: kanonische Direction/Status statt harter Legacy-Strings
  // ('we_lend'/'we_borrow'/'open'). Sonst fielen kanonische MONEY_GIVEN/MONEY_RECEIVED
  // UND teil-rueckgezahlte (PARTIALLY_REPAID) Kredite raus. Deckt sich mit
  // ReconciliationPage (domainLoanReceivable/Payable) + Dashboard: nur CANCELLED
  // ausschliessen, outstanding = amount - paid (REPAID traegt damit 0).
  const debtRows = query(
    `SELECT d.direction, d.amount,
            COALESCE((SELECT SUM(amount) FROM debt_payments WHERE debt_id = d.id), 0) AS paid
       FROM debts d
      WHERE d.branch_id = ? AND UPPER(COALESCE(d.status, 'OPEN')) != 'CANCELLED'`,
    [branchId]
  );
  let debtsOwedToUs = 0, debtsWeOwe = 0;
  for (const r of debtRows) {
    const outstanding = Math.max(0, (Number(r.amount) || 0) - (Number(r.paid) || 0));
    if (outstanding <= 0) continue;
    if (canonicalLoanDirection(r.direction as string) === 'MONEY_GIVEN') debtsOwedToUs += outstanding;
    else debtsWeOwe += outstanding;
  }

  // ── Previous period (optional) ─────────────────────────
  let previousPeriod: ReportContext['previousPeriod'];
  if (opts.withPreviousPeriod) {
    const prev = previousPeriodOf(period);
    // M-13: Vorperiode mit DERSELBEN Umsatzregel (FINAL-only, Refunds ab) — sonst
    // waere der Periodenvergleich Aepfel-vs-Birnen.
    const prevSales = loadSalesMetrics(branchId, prev.startISO, prev.endISO);
    previousPeriod = {
      grossRevenue: prevSales.gross,
      profit: prevSales.profit,
      invoiceCount: prevSales.count,
    };
  }

  return {
    period,
    generatedAt: nowISO,
    branchId,
    currency: opts.currency || 'BHD',
    revenue: {
      grossRevenue, netRevenue, vat, profit,
      marginPct: safeDiv(profit, netRevenue) * 100,
      invoiceCount, avgInvoiceValue: safeDiv(grossRevenue, invoiceCount),
    },
    cashflow: { cashReceived, bankReceived, cardReceived, cardFeesLost, taxPaid, netInflow },
    stock: {
      totalItems, totalPurchaseValue, totalPlannedSaleValue, avgDaysInStock,
      slowMovers, byCategory: stockByCat,
    },
    sales: { byBrand: salesByBrand, byCategory: salesByCategory, topProducts },
    customers: {
      active: num(custSummary, 'active'),
      dormant: num(custSummary, 'dormant'),
      newInPeriod: num(custSummary, 'new_in_period'),
      topByRevenue: topCustomers,
      inactiveVips,
    },
    operations: {
      openRepairs: num(opsRepairs, 'cnt'),
      openOrders: num(opsOrders, 'cnt'),
      overdueInvoices: num(opsInvoicesOverdue, 'cnt'),
      overdueAmount: num(opsInvoicesOverdue, 'outstanding'),
      openConsignments: num(opsConsignments, 'cnt'),
      activeConsignmentValue: num(opsConsignments, 'val'),
    },
    debts: {
      owedToUs: debtsOwedToUs,
      weOwe: debtsWeOwe,
    },
    previousPeriod,
  };
}
