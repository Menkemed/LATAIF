// ═══════════════════════════════════════════════════════════
// LATAIF — AI Business Review Engine: Tool Layer
// OpenAI Function-Calling tools that read from local Zustand
// stores. Each tool returns a typed AIBlock the chat renders.
// ═══════════════════════════════════════════════════════════

import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useOrderStore } from '@/stores/orderStore';
import { useOfferStore } from '@/stores/offerStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { canonicalStockStatus } from '@/core/models/types';
import type { Invoice, Customer, Product } from '@/core/models/types';

// ── Renderable block types (return shape) ───────────────────

export type LinkCell = { text: string; link?: string };
export type Cell = string | number | LinkCell;
export type Tone = 'green' | 'red' | 'orange' | 'blue' | 'neutral';

export interface KPI {
  label: string;
  value: string;
  tone?: Tone;
  hint?: string;
}

export type AIBlock =
  | { type: 'kpis'; title: string; kpis: KPI[] }
  | { type: 'table'; title: string; columns: string[]; rows: Cell[][]; align?: ('left' | 'right' | 'center')[] }
  | { type: 'review'; title: string; markdown: string; kpis?: KPI[]; recommendations?: string[] }
  | { type: 'text'; markdown: string }
  | { type: 'error'; message: string };

// ── Helpers ─────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function pct(n: number): string { return `${(n).toFixed(1)}%`; }
function name(c?: Customer): string { return c ? `${c.firstName} ${c.lastName}`.trim() || c.company || '—' : '—'; }
function inRange(iso: string | undefined, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  const cut = Date.now() - days * 86_400_000;
  return t >= cut;
}

// ── Tool executors ──────────────────────────────────────────

function toolTopCustomers(args: { period_days?: number; sort_by?: 'revenue' | 'margin' | 'invoice_count'; limit?: number }): AIBlock {
  const days = Math.max(1, args.period_days ?? 30);
  const sortBy = args.sort_by || 'revenue';
  const limit = Math.max(1, Math.min(100, args.limit ?? 10));

  const invoices = useInvoiceStore.getState().invoices.filter(i => i.status !== 'DRAFT' && i.status !== 'CANCELLED' && inRange(i.issuedAt || i.createdAt, days));
  const customers = useCustomerStore.getState().customers;

  const agg = new Map<string, { revenue: number; margin: number; count: number; open: number }>();
  for (const inv of invoices) {
    const cur = agg.get(inv.customerId) || { revenue: 0, margin: 0, count: 0, open: 0 };
    cur.revenue += inv.grossAmount || 0;
    cur.margin += inv.marginSnapshot || 0;
    cur.count += 1;
    cur.open += Math.max(0, (inv.grossAmount || 0) - (inv.paidAmount || 0));
    agg.set(inv.customerId, cur);
  }

  const ranked = [...agg.entries()]
    .map(([id, v]) => ({ id, ...v, marginPct: v.revenue > 0 ? (v.margin / v.revenue) * 100 : 0 }))
    .sort((a, b) => sortBy === 'margin' ? b.margin - a.margin : sortBy === 'invoice_count' ? b.count - a.count : b.revenue - a.revenue)
    .slice(0, limit);

  if (ranked.length === 0) {
    return { type: 'text', markdown: `_No invoices in the last ${days} days._` };
  }

  return {
    type: 'table',
    title: `Top ${ranked.length} customers — last ${days} days (sorted by ${sortBy})`,
    columns: ['Customer', 'Revenue (BHD)', 'Margin (BHD)', 'Margin %', 'Invoices', 'Open (BHD)'],
    align: ['left', 'right', 'right', 'right', 'right', 'right'],
    rows: ranked.map(r => {
      const c = customers.find(x => x.id === r.id);
      return [
        { text: name(c), link: `/clients/${r.id}` },
        fmt(r.revenue),
        fmt(r.margin),
        pct(r.marginPct),
        r.count,
        fmt(r.open),
      ];
    }),
  };
}

function toolQueryInvoices(args: { status?: string; customer_id?: string; period_days?: number; min_amount?: number; limit?: number }): AIBlock {
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const customers = useCustomerStore.getState().customers;
  let list: Invoice[] = useInvoiceStore.getState().invoices;
  if (args.status) list = list.filter(i => i.status === args.status);
  if (args.customer_id) list = list.filter(i => i.customerId === args.customer_id);
  if (args.period_days) list = list.filter(i => inRange(i.issuedAt || i.createdAt, args.period_days!));
  if (args.min_amount) list = list.filter(i => (i.grossAmount || 0) >= args.min_amount!);
  list = list.sort((a, b) => (b.issuedAt || b.createdAt).localeCompare(a.issuedAt || a.createdAt)).slice(0, limit);

  if (list.length === 0) return { type: 'text', markdown: '_No invoices match the filter._' };

  return {
    type: 'table',
    title: `Invoices (${list.length}${list.length === limit ? '+' : ''})`,
    columns: ['#', 'Date', 'Customer', 'Status', 'Gross (BHD)', 'Paid (BHD)', 'Open (BHD)'],
    align: ['left', 'left', 'left', 'left', 'right', 'right', 'right'],
    rows: list.map(i => {
      const c = customers.find(x => x.id === i.customerId);
      const open = Math.max(0, (i.grossAmount || 0) - (i.paidAmount || 0));
      return [
        { text: i.invoiceNumber, link: `/invoices/${i.id}` },
        (i.issuedAt || i.createdAt).slice(0, 10),
        { text: name(c), link: `/clients/${i.customerId}` },
        i.status,
        fmt(i.grossAmount || 0),
        fmt(i.paidAmount || 0),
        fmt(open),
      ];
    }),
  };
}

function toolOpenReceivables(_args: { min_amount?: number; older_than_days?: number }): AIBlock {
  const args = _args || {};
  const customers = useCustomerStore.getState().customers;
  const invoices = useInvoiceStore.getState().invoices.filter(i => {
    if (i.status === 'DRAFT' || i.status === 'CANCELLED') return false;
    const open = (i.grossAmount || 0) - (i.paidAmount || 0);
    if (open <= 0.01) return false;
    if (args.min_amount && open < args.min_amount) return false;
    if (args.older_than_days) {
      const issued = new Date(i.issuedAt || i.createdAt).getTime();
      const ageDays = (Date.now() - issued) / 86_400_000;
      if (ageDays < args.older_than_days) return false;
    }
    return true;
  });

  if (invoices.length === 0) return { type: 'text', markdown: '_No open receivables._' };

  const totalOpen = invoices.reduce((s, i) => s + ((i.grossAmount || 0) - (i.paidAmount || 0)), 0);

  return {
    type: 'table',
    title: `Open receivables — ${invoices.length} invoices · Total ${fmt(totalOpen)} BHD`,
    columns: ['Invoice', 'Date', 'Due', 'Customer', 'Status', 'Open (BHD)'],
    align: ['left', 'left', 'left', 'left', 'left', 'right'],
    rows: invoices
      .sort((a, b) => ((b.grossAmount || 0) - (b.paidAmount || 0)) - ((a.grossAmount || 0) - (a.paidAmount || 0)))
      .map(i => {
        const c = customers.find(x => x.id === i.customerId);
        const open = (i.grossAmount || 0) - (i.paidAmount || 0);
        return [
          { text: i.invoiceNumber, link: `/invoices/${i.id}` },
          (i.issuedAt || i.createdAt).slice(0, 10),
          i.dueAt?.slice(0, 10) || '—',
          { text: name(c), link: `/clients/${i.customerId}` },
          i.status,
          fmt(open),
        ];
      }),
  };
}

function toolInventoryAtRisk(args: { min_days_idle?: number; min_value?: number; limit?: number }): AIBlock {
  const minDays = Math.max(0, args.min_days_idle ?? 90);
  const minValue = Math.max(0, args.min_value ?? 0);
  const limit = Math.max(1, Math.min(200, args.limit ?? 30));

  const products = useProductStore.getState().products as Product[];
  const at = products.filter(p => {
    const cs = canonicalStockStatus(p.stockStatus);
    if (cs !== 'IN_STOCK' && cs !== 'RESERVED') return false;
    const days = p.daysInStock || (p.purchaseDate ? Math.floor((Date.now() - new Date(p.purchaseDate).getTime()) / 86_400_000) : 0);
    if (days < minDays) return false;
    if ((p.purchasePrice || 0) < minValue) return false;
    return true;
  });

  if (at.length === 0) return { type: 'text', markdown: `_No inventory idle for ≥ ${minDays} days above ${fmt(minValue)} BHD._` };

  const totalCapital = at.reduce((s, p) => s + (p.purchasePrice || 0), 0);

  return {
    type: 'table',
    title: `Slow-moving stock — ${at.length} items · Capital tied up ${fmt(totalCapital)} BHD`,
    columns: ['Product', 'SKU', 'Days idle', 'Purchase (BHD)', 'Asking (BHD)'],
    align: ['left', 'left', 'right', 'right', 'right'],
    rows: at
      .sort((a, b) => (b.purchasePrice || 0) - (a.purchasePrice || 0))
      .slice(0, limit)
      .map(p => {
        const days = p.daysInStock || (p.purchaseDate ? Math.floor((Date.now() - new Date(p.purchaseDate).getTime()) / 86_400_000) : 0);
        return [
          { text: `${p.brand} ${p.name}`.trim(), link: `/collection/${p.id}` },
          p.sku || '—',
          days,
          fmt(p.purchasePrice || 0),
          fmt(p.plannedSalePrice || p.purchasePrice || 0),
        ];
      }),
  };
}

function toolMonthlyReview(args: { year?: number; month?: number }): AIBlock {
  const now = new Date();
  const year = args.year ?? now.getFullYear();
  const month = args.month ?? (now.getMonth() + 1); // 1-12
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const prevStart = new Date(Date.UTC(year, month - 2, 1));
  const prevEnd = start;
  const monthLabel = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const allInvoices = useInvoiceStore.getState().invoices;
  const customers = useCustomerStore.getState().customers;
  const products = useProductStore.getState().products as Product[];
  const expenses = useExpenseStore.getState().expenses;
  const purchases = usePurchaseStore.getState().purchases;
  const orders = useOrderStore.getState().orders;
  const offers = useOfferStore.getState().offers;

  const inP = (iso?: string, s = start, e = end) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= s.getTime() && t < e.getTime();
  };

  const cur = allInvoices.filter(i => i.status !== 'DRAFT' && i.status !== 'CANCELLED' && inP(i.issuedAt || i.createdAt));
  const prev = allInvoices.filter(i => i.status !== 'DRAFT' && i.status !== 'CANCELLED' && inP(i.issuedAt || i.createdAt, prevStart, prevEnd));

  const sumGross = (xs: Invoice[]) => xs.reduce((s, i) => s + (i.grossAmount || 0), 0);
  const sumMargin = (xs: Invoice[]) => xs.reduce((s, i) => s + (i.marginSnapshot || 0), 0);
  const sumPaid = (xs: Invoice[]) => xs.reduce((s, i) => s + (i.paidAmount || 0), 0);

  const revenue = sumGross(cur);
  const prevRevenue = sumGross(prev);
  const revGrowth = prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : 0;
  const margin = sumMargin(cur);
  const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;
  const collected = sumPaid(cur);
  const open = revenue - collected;

  const newClients = customers.filter(c => inP(c.createdAt)).length;
  const offersCount = offers.filter(o => inP(o.createdAt)).length;
  const ordersCount = orders.filter(o => inP(o.createdAt)).length;

  const expensesTotal = expenses.filter(e => inP(e.expenseDate || e.createdAt)).reduce((s, e) => s + (e.amount || 0), 0);
  const purchasesTotal = purchases.filter(p => inP(p.purchaseDate || p.createdAt)).reduce((s, p) => s + (p.totalAmount || 0), 0);

  const inventoryValue = products.filter(p => canonicalStockStatus(p.stockStatus) === 'IN_STOCK').reduce((s, p) => s + (p.purchasePrice || 0), 0);

  // Top 3 customers by revenue this month
  const custAgg = new Map<string, number>();
  for (const i of cur) custAgg.set(i.customerId, (custAgg.get(i.customerId) || 0) + (i.grossAmount || 0));
  const top3 = [...custAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const recommendations: string[] = [];
  if (open > revenue * 0.3) recommendations.push(`Open receivables (${fmt(open)} BHD) exceed 30% of revenue — chase outstanding invoices.`);
  if (marginPct < 20 && revenue > 0) recommendations.push(`Margin is only ${pct(marginPct)} — review pricing or tax-scheme allocation.`);
  if (revGrowth < -10) recommendations.push(`Revenue dropped ${pct(Math.abs(revGrowth))} vs prior month — investigate top-customer activity.`);
  if (offersCount > 0 && ordersCount === 0) recommendations.push(`${offersCount} offers but 0 orders — follow-up cadence may be missing.`);
  if (recommendations.length === 0) recommendations.push('No critical issues detected for this period.');

  const markdown = [
    `## Business Review — ${monthLabel}`,
    ``,
    `**Revenue:** ${fmt(revenue)} BHD${prevRevenue > 0 ? ` (${revGrowth >= 0 ? '+' : ''}${revGrowth.toFixed(1)}% vs prev. month)` : ''}`,
    `**Margin:** ${fmt(margin)} BHD (${pct(marginPct)})`,
    `**Collected:** ${fmt(collected)} BHD · **Open:** ${fmt(open)} BHD`,
    `**Invoices issued:** ${cur.length} · **New clients:** ${newClients}`,
    `**Offers / Orders:** ${offersCount} / ${ordersCount}`,
    `**Expenses:** ${fmt(expensesTotal)} BHD · **Purchases:** ${fmt(purchasesTotal)} BHD`,
    `**Inventory value:** ${fmt(inventoryValue)} BHD`,
    ``,
    top3.length ? `### Top 3 customers` : '',
    ...top3.map(([id, rev]) => {
      const c = customers.find(x => x.id === id);
      return `- ${name(c)} — ${fmt(rev)} BHD`;
    }),
  ].filter(Boolean).join('\n');

  return {
    type: 'review',
    title: `Business Review — ${monthLabel}`,
    markdown,
    kpis: [
      { label: 'Revenue', value: `${fmt(revenue)} BHD`, tone: revGrowth >= 0 ? 'green' : 'red', hint: prevRevenue > 0 ? `${revGrowth >= 0 ? '+' : ''}${revGrowth.toFixed(1)}% MoM` : undefined },
      { label: 'Margin', value: pct(marginPct), tone: marginPct >= 25 ? 'green' : marginPct >= 15 ? 'orange' : 'red' },
      { label: 'Open AR', value: `${fmt(open)} BHD`, tone: open > revenue * 0.3 ? 'red' : 'neutral' },
      { label: 'Invoices', value: String(cur.length) },
      { label: 'New Clients', value: String(newClients) },
      { label: 'Stock Value', value: `${fmt(inventoryValue)} BHD`, tone: 'blue' },
    ],
    recommendations,
  };
}

// ── Registry ────────────────────────────────────────────────

export type ToolName =
  | 'top_customers'
  | 'query_invoices'
  | 'open_receivables'
  | 'inventory_at_risk'
  | 'monthly_review';

export const toolExecutors: Record<ToolName, (args: any) => AIBlock> = {
  top_customers: toolTopCustomers,
  query_invoices: toolQueryInvoices,
  open_receivables: toolOpenReceivables,
  inventory_at_risk: toolInventoryAtRisk,
  monthly_review: toolMonthlyReview,
};

// OpenAI tool schemas
export const toolSchemas = [
  {
    type: 'function' as const,
    function: {
      name: 'top_customers',
      description: 'Returns a ranked table of top customers within a recent time window. Use for questions like "Top customers last 30 days", "best clients by margin".',
      parameters: {
        type: 'object',
        properties: {
          period_days: { type: 'number', description: 'Look-back window in days. Default 30.' },
          sort_by:    { type: 'string', enum: ['revenue', 'margin', 'invoice_count'], description: 'Ranking criterion. Default revenue.' },
          limit:      { type: 'number', description: 'Max rows. Default 10.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'query_invoices',
      description: 'Lists invoices filtered by status / customer / time-window / min amount. Use for questions about specific invoices.',
      parameters: {
        type: 'object',
        properties: {
          status:       { type: 'string', enum: ['DRAFT', 'PARTIAL', 'FINAL', 'CANCELLED'] },
          customer_id:  { type: 'string', description: 'Optional customer UUID to filter on.' },
          period_days:  { type: 'number', description: 'Restrict to invoices issued in last N days.' },
          min_amount:   { type: 'number', description: 'Minimum gross amount in BHD.' },
          limit:        { type: 'number', description: 'Max rows. Default 50.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_receivables',
      description: 'Returns all unpaid (open) invoices with the open amount, optionally filtered by minimum open amount or age in days. Use for "who owes us money", "overdue invoices".',
      parameters: {
        type: 'object',
        properties: {
          min_amount:        { type: 'number' },
          older_than_days:   { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'inventory_at_risk',
      description: 'Returns slow-moving stock that ties up capital. Items must have been in stock for at least min_days_idle days.',
      parameters: {
        type: 'object',
        properties: {
          min_days_idle: { type: 'number', description: 'Minimum days idle. Default 90.' },
          min_value:     { type: 'number', description: 'Minimum purchase price in BHD.' },
          limit:         { type: 'number', description: 'Max rows. Default 30.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'monthly_review',
      description: 'Generates a full month-over-month business review with KPIs, top customers, and concrete recommendations. Use for "monthly review", "March report", "executive summary".',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number', description: 'Calendar year (e.g. 2026). Default current year.' },
          month: { type: 'number', description: 'Calendar month 1-12. Default current month.' },
        },
      },
    },
  },
];

// System prompt for the engine.
export const SYSTEM_PROMPT = `You are LATAIF's AI Business Review Engine — a data analyst for a luxury-goods CRM.

You have access to read-only tools that query the local CRM database. Your job:
1. Understand the user's question (German or English).
2. Pick the RIGHT tool(s) to fetch facts. NEVER invent numbers.
3. After the tool calls, write a short interpretation: 1-3 sentences highlighting what stands out and one concrete next step. Do NOT re-list rows the table already shows.
4. Currency is BHD throughout.
5. If the user asks for a "monthly review" or "executive summary", call monthly_review — its output already contains KPIs and recommendations; only add 1 sentence.
6. If the question is unclear, ask one clarifying question instead of guessing.

Output format:
- Tool calls render as tables / KPI cards / reviews automatically.
- Your text response is rendered as Markdown above/below the rendered blocks.
- Keep prose tight. No filler.`;
