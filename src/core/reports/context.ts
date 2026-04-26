// ═══════════════════════════════════════════════════════════
// LATAIF — Report Context Builder
// Extracts structured KPI snapshots from the DB for a period,
// re-used by Executive Summary, Custom Reports, Chat and Alerts.
// ═══════════════════════════════════════════════════════════

import { query } from '@/core/db/helpers';

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

export function buildReportContext(opts: BuildOpts): ReportContext {
  const { branchId, period } = opts;
  const { startISO, endISO } = period;

  // ── Revenue ────────────────────────────────────────────
  const revRow = firstRow(
    `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(gross_amount), 0) AS gross,
            COALESCE(SUM(net_amount), 0)  AS net,
            COALESCE(SUM(vat_amount), 0)  AS vat,
            COALESCE(SUM(margin_snapshot), 0) AS profit
     FROM invoices
     WHERE branch_id = ? AND status != 'CANCELLED' AND status != 'DRAFT'
       AND COALESCE(issued_at, created_at) >= ? AND COALESCE(issued_at, created_at) < ?`,
    [branchId, startISO, endISO]
  );
  const invoiceCount = num(revRow, 'cnt');
  const grossRevenue = num(revRow, 'gross');
  const netRevenue = num(revRow, 'net');
  const vat = num(revRow, 'vat');
  const profit = num(revRow, 'profit');

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
  const cardFeeRateRow = firstRow(
    `SELECT value FROM settings WHERE branch_id = ? AND key = 'finance.card_fee_rate'`,
    [branchId]
  );
  const cardFeeRate = parseFloat((cardFeeRateRow?.value as string) || '2.2') || 2.2;
  const cardFeesLost = Math.round(cardReceived * cardFeeRate) / 100;

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
            COALESCE(SUM(il.line_total - il.purchase_price_snapshot), 0) AS profit
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
            COALESCE(SUM(il.line_total - il.purchase_price_snapshot), 0) AS profit
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
            (il.line_total - il.purchase_price_snapshot) AS profit
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

  // ── Debts ──────────────────────────────────────────────
  const debtsOwedToUs = firstRow(
    `SELECT COALESCE(SUM(d.amount - COALESCE(p.paid, 0)), 0) AS remaining
     FROM debts d
     LEFT JOIN (SELECT debt_id, SUM(amount) AS paid FROM debt_payments GROUP BY debt_id) p
       ON p.debt_id = d.id
     WHERE d.branch_id = ? AND d.direction = 'we_lend' AND d.status = 'open'`,
    [branchId]
  );
  const debtsWeOwe = firstRow(
    `SELECT COALESCE(SUM(d.amount - COALESCE(p.paid, 0)), 0) AS remaining
     FROM debts d
     LEFT JOIN (SELECT debt_id, SUM(amount) AS paid FROM debt_payments GROUP BY debt_id) p
       ON p.debt_id = d.id
     WHERE d.branch_id = ? AND d.direction = 'we_borrow' AND d.status = 'open'`,
    [branchId]
  );

  // ── Previous period (optional) ─────────────────────────
  let previousPeriod: ReportContext['previousPeriod'];
  if (opts.withPreviousPeriod) {
    const prev = previousPeriodOf(period);
    const prevRow = firstRow(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(gross_amount), 0) AS gross,
              COALESCE(SUM(margin_snapshot), 0) AS profit
       FROM invoices
       WHERE branch_id = ? AND status != 'CANCELLED' AND status != 'DRAFT'
         AND COALESCE(issued_at, created_at) >= ? AND COALESCE(issued_at, created_at) < ?`,
      [branchId, prev.startISO, prev.endISO]
    );
    previousPeriod = {
      grossRevenue: num(prevRow, 'gross'),
      profit: num(prevRow, 'profit'),
      invoiceCount: num(prevRow, 'cnt'),
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
      owedToUs: num(debtsOwedToUs, 'remaining'),
      weOwe: num(debtsWeOwe, 'remaining'),
    },
    previousPeriod,
  };
}
