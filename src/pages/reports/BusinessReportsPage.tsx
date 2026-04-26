// Plan §Reports — 8 strukturierte Reports mit Export
// SALES / PROFIT / TAX / INVENTORY / EXPENSE / PAYABLES / RECEIVABLES / PARTNER
import { useEffect, useMemo, useState } from 'react';
import { Download, BarChart3, TrendingUp, Percent, Package, Wallet, ShoppingCart, FileText, UserPlus } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useCustomerStore } from '@/stores/customerStore';
import { exportCsv, exportExcel } from '@/core/utils/export-file';
import { usePartnerStore } from '@/stores/partnerStore';
import { usePurchaseStore } from '@/stores/purchaseStore';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type ReportKey = 'sales' | 'profit' | 'tax' | 'inventory' | 'expense' | 'payables' | 'receivables' | 'partner';

interface ReportDef {
  key: ReportKey;
  label: string;
  icon: typeof BarChart3;
  color: string;
}

const REPORTS: ReportDef[] = [
  { key: 'sales',       label: 'Sales',       icon: BarChart3,    color: '#0F0F10' },
  { key: 'profit',      label: 'Profit',      icon: TrendingUp,   color: '#16A34A' },
  { key: 'tax',         label: 'Tax (VAT)',   icon: Percent,      color: '#D97706' },
  { key: 'inventory',   label: 'Inventory',   icon: Package,      color: '#2563EB' },
  { key: 'expense',     label: 'Expenses',    icon: Wallet,       color: '#DC2626' },
  { key: 'payables',    label: 'Payables',    icon: ShoppingCart, color: '#D97706' },
  { key: 'receivables', label: 'Receivables', icon: FileText,     color: '#16A34A' },
  { key: 'partner',     label: 'Partners',    icon: UserPlus,     color: '#7C3AED' },
];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function downloadCsv(filename: string, rows: string[][]) {
  const escape = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const csv = rows.map(r => r.map(escape).join(',')).join('\n');
  exportCsv(filename, csv);
}

// Plan §Reports §5: Excel export. HTML-table with Excel mime opens in Excel/Numbers.
function downloadExcel(filename: string, title: string, rows: string[][]) {
  const [header, ...body] = rows;
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8">
<style>table{border-collapse:collapse;font-family:Arial,sans-serif}th,td{border:1px solid #ccc;padding:6px 10px;font-size:12px}th{background:#EFECE2}</style>
</head><body><h3>${escapeHtml(title)}</h3><table>
<thead><tr>${(header || []).map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
<tbody>${body.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></body></html>`;
  exportExcel(filename, html);
}

// Plan §Reports §5: PDF export. Opens formatted print view; Browser dialog → "Save as PDF".
function printPdf(title: string, rows: string[][]) {
  const [header, ...body] = rows;
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  const now = new Date().toLocaleString('en-GB');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;padding:40px;color:#0F0F10}
  h1{font-size:22px;font-weight:400;margin:0 0 4px}
  .sub{font-size:11px;color:#6B7280;margin-bottom:24px;letter-spacing:0.06em;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{padding:8px 12px;font-size:12px;border-bottom:1px solid #E5E1D6;text-align:left}
  th{background:#F7F5EE;font-weight:500;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#6B7280}
  tbody tr:last-child{font-weight:500}
  .footer{margin-top:32px;font-size:10px;color:#6B7280;border-top:1px solid #E5E1D6;padding-top:12px}
  @media print{body{padding:20px}.no-print{display:none}}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="sub">Generated ${now} · LATAIF</div>
<table>
<thead><tr>${(header || []).map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
<tbody>${body.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>
<div class="footer">LATAIF Business Report · ${escapeHtml(title)}</div>
<script>window.addEventListener('load',()=>{setTimeout(()=>window.print(),300)});</script>
</body></html>`);
  w.document.close();
}

type ExportFormat = 'csv' | 'xlsx' | 'pdf';

// Plan §Reports §4: Filter (Datum/Kategorie/Kunde/Supplier/Status) + §6: Live vs Period.
type Period = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

export function BusinessReportsPage() {
  const [active, setActive] = useState<ReportKey>('sales');
  const [period, setPeriod] = useState<Period>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [mode, setMode] = useState<'live' | 'period'>('period');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [customerFilter, setCustomerFilter] = useState<string>('');
  const [supplierFilter, setSupplierFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const periodRange = useMemo<{ from: string; to: string }>(() => {
    const now = new Date();
    const toIso = now.toISOString();
    if (mode === 'live' || period === 'all') return { from: '1970-01-01', to: toIso };
    if (period === 'today') return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), to: toIso };
    if (period === 'week') { const d = new Date(now); d.setDate(now.getDate() - 7); return { from: d.toISOString(), to: toIso }; }
    if (period === 'month') { const d = new Date(now); d.setMonth(now.getMonth() - 1); return { from: d.toISOString(), to: toIso }; }
    if (period === 'year') { const d = new Date(now); d.setFullYear(now.getFullYear() - 1); return { from: d.toISOString(), to: toIso }; }
    if (period === 'custom') return { from: customFrom || '1970-01-01', to: customTo ? customTo + 'T23:59:59' : toIso };
    return { from: '1970-01-01', to: toIso };
  }, [mode, period, customFrom, customTo]);

  const { invoices, loadInvoices } = useInvoiceStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();
  const { expenses, loadExpenses, getTotalsByCategory } = useExpenseStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { partners, loadPartners } = usePartnerStore();
  const { loadPurchases } = usePurchaseStore();

  useEffect(() => {
    loadInvoices(); loadProducts(); loadCategories();
    loadExpenses(); loadSuppliers(); loadCustomers(); loadPartners(); loadPurchases();
  }, [loadInvoices, loadProducts, loadCategories, loadExpenses, loadSuppliers, loadCustomers, loadPartners, loadPurchases]);

  // Plan §Reports §4+6: Zeitraum-Filter auf Invoice-Liste.
  const filteredInvoices = useMemo(() => {
    return invoices.filter(i => {
      if (statusFilter && i.status !== statusFilter) return false;
      if (customerFilter && i.customerId !== customerFilter) return false;
      const when = i.issuedAt || i.createdAt;
      if (!when) return true;
      return when >= periodRange.from && when <= periodRange.to;
    });
  }, [invoices, periodRange, statusFilter, customerFilter]);

  // ── Sales Report (Plan §Reports §A) — only FINAL count (Plan §Sales §3)
  const salesReport = useMemo(() => {
    const finalInvs = filteredInvoices.filter(i => i.status === 'FINAL');
    const gross = finalInvs.reduce((s, i) => s + i.grossAmount, 0);
    const vat = finalInvs.reduce((s, i) => s + i.vatAmount, 0);
    const net = finalInvs.reduce((s, i) => s + i.netAmount, 0);
    const byMonth: Record<string, number> = {};
    for (const i of finalInvs) {
      const m = (i.issuedAt || i.createdAt || '').substring(0, 7);
      byMonth[m] = (byMonth[m] || 0) + i.grossAmount;
    }
    return { count: finalInvs.length, gross, vat, net, byMonth };
  }, [filteredInvoices]);

  // ── Profit Report (Plan §Reports §B) — optional Category-Filter via invoice_lines
  const profitReport = useMemo(() => {
    const finalInvs = filteredInvoices.filter(i => i.status === 'FINAL');
    let profit = 0, cost = 0;
    for (const i of finalInvs) {
      if (categoryFilter) {
        // Nur Zeilen mit Kategorie-Filter-Match
        for (const l of i.lines) {
          const prod = products.find(p => p.id === l.productId);
          if (prod?.categoryId === categoryFilter) {
            profit += l.unitPrice - (l.purchasePriceSnapshot || 0);
            cost += l.purchasePriceSnapshot || 0;
          }
        }
      } else {
        profit += (i.marginSnapshot || 0);
        cost += (i.purchasePriceSnapshot || 0);
      }
    }
    const margin = salesReport.gross > 0 ? (profit / salesReport.gross) * 100 : 0;
    return { profit, cost, margin };
  }, [filteredInvoices, salesReport.gross, categoryFilter, products]);

  // ── Tax Report (Plan §Reports §C)
  const taxReport = useMemo(() => {
    const finalInvs = filteredInvoices.filter(i => i.status === 'FINAL');
    let vat10 = 0, marginVat = 0, zero = 0;
    for (const i of finalInvs) {
      for (const l of i.lines) {
        if (l.taxScheme === 'VAT_10') vat10 += l.vatAmount;
        else if (l.taxScheme === 'MARGIN') {
          const profit = Math.max(0, l.unitPrice - l.purchasePriceSnapshot);
          marginVat += profit * 10 / 110;
        } else if (l.taxScheme === 'ZERO') zero += l.lineTotal;
      }
    }
    return { vat10, marginVat, zero };
  }, [filteredInvoices]);

  // ── Inventory Report (Plan §Reports §D)
  // Plan §Commission §5: nur OWN-Ware zählt als Asset.
  const inventoryReport = useMemo(() => {
    const inStock = products.filter(p =>
      (p.stockStatus === 'in_stock' || p.stockStatus === 'IN_STOCK') && p.sourceType === 'OWN'
    );
    const value = inStock.reduce((s, p) => s + p.purchasePrice, 0);
    const byCat: Record<string, { count: number; value: number; name: string }> = {};
    for (const p of inStock) {
      const c = categories.find(x => x.id === p.categoryId);
      const name = c?.name || 'Uncategorized';
      const e = byCat[p.categoryId] || { count: 0, value: 0, name };
      e.count += 1; e.value += p.purchasePrice; e.name = name;
      byCat[p.categoryId] = e;
    }
    return { count: inStock.length, value, byCat: Object.values(byCat) };
  }, [products, categories]);

  // ── Expense Report (Plan §Reports §E)
  const expenseReport = useMemo(() => {
    const totals = getTotalsByCategory();
    const total = Object.values(totals).reduce((s, v) => s + v, 0);
    // By month
    const byMonth: Record<string, number> = {};
    for (const e of expenses) {
      const m = (e.expenseDate || '').substring(0, 7);
      byMonth[m] = (byMonth[m] || 0) + e.amount;
    }
    return { total, totals, byMonth };
  }, [expenses, getTotalsByCategory]);

  // ── Payables Report (Plan §Reports §F)
  const payablesReport = useMemo(() => {
    const bySupplier = suppliers.map(s => ({
      name: s.name,
      totalPurchases: s.totalPurchases || 0,
      totalPaid: s.totalPaid || 0,
      outstanding: s.outstandingBalance || 0,
    })).filter(s => s.outstanding > 0);
    const total = bySupplier.reduce((s, x) => s + x.outstanding, 0);
    return { total, bySupplier };
  }, [suppliers]);

  // ── Receivables Report (Plan §Reports §G)
  const receivablesReport = useMemo(() => {
    const partial = invoices.filter(i => i.status === 'PARTIAL');
    const byCustomer: Record<string, { name: string; outstanding: number; count: number }> = {};
    for (const inv of partial) {
      const c = customers.find(x => x.id === inv.customerId);
      const name = c ? `${c.firstName} ${c.lastName}` : inv.customerId.slice(0, 8);
      const e = byCustomer[inv.customerId] || { name, outstanding: 0, count: 0 };
      e.outstanding += Math.max(0, inv.grossAmount - inv.paidAmount); e.count += 1;
      byCustomer[inv.customerId] = e;
    }
    const total = Object.values(byCustomer).reduce((s, v) => s + v.outstanding, 0);
    return { total, byCustomer: Object.values(byCustomer) };
  }, [invoices, customers]);

  // ── Partner Report (Plan §Reports §H)
  const partnerReport = useMemo(() => {
    const rows = partners.map(p => ({
      name: p.name,
      share: p.sharePercentage,
      invested: p.totalInvested || 0,
      withdrawn: p.totalWithdrawn || 0,
      profitShare: p.totalProfitShare || 0,
      balance: p.balance || 0,
    }));
    const totalBalance = rows.reduce((s, x) => s + x.balance, 0);
    return { rows, totalBalance };
  }, [partners]);

  function buildReportRows(): { title: string; rows: string[][] } {
    switch (active) {
      case 'sales':
        return { title: 'Sales Report', rows: [
          ['Month', 'Gross Revenue'],
          ...Object.entries(salesReport.byMonth).sort().map(([m, v]) => [m, v.toFixed(2)]),
          ['', ''],
          ['Total Count', String(salesReport.count)],
          ['Total Gross', salesReport.gross.toFixed(2)],
          ['Total VAT', salesReport.vat.toFixed(2)],
          ['Total Net', salesReport.net.toFixed(2)],
        ]};
      case 'profit':
        return { title: 'Profit Report', rows: [
          ['Metric', 'Value (BHD)'],
          ['Gross Revenue', salesReport.gross.toFixed(2)],
          ['Total Cost (Purchase)', profitReport.cost.toFixed(2)],
          ['Total Profit', profitReport.profit.toFixed(2)],
          ['Margin %', profitReport.margin.toFixed(2)],
        ]};
      case 'tax':
        return { title: 'Tax Report (VAT)', rows: [
          ['Tax Type', 'Amount (BHD)'],
          ['VAT 10% (visible)', taxReport.vat10.toFixed(2)],
          ['Margin VAT (internal)', taxReport.marginVat.toFixed(2)],
          ['Zero-Rated (0% revenue)', taxReport.zero.toFixed(2)],
        ]};
      case 'inventory':
        return { title: 'Inventory Report', rows: [
          ['Category', 'Items in stock', 'Value (BHD)'],
          ...inventoryReport.byCat.map(c => [c.name, String(c.count), c.value.toFixed(2)]),
          ['', '', ''],
          ['Total', String(inventoryReport.count), inventoryReport.value.toFixed(2)],
        ]};
      case 'expense':
        return { title: 'Expense Report', rows: [
          ['Category', 'Amount (BHD)'],
          ...Object.entries(expenseReport.totals).map(([k, v]) => [k, v.toFixed(2)]),
          ['', ''],
          ['Total', expenseReport.total.toFixed(2)],
        ]};
      case 'payables':
        return { title: 'Payables Report', rows: [
          ['Supplier', 'Total Purchases', 'Paid', 'Outstanding'],
          ...payablesReport.bySupplier.map(s => [s.name, s.totalPurchases.toFixed(2), s.totalPaid.toFixed(2), s.outstanding.toFixed(2)]),
          ['', '', '', ''],
          ['Total outstanding', '', '', payablesReport.total.toFixed(2)],
        ]};
      case 'receivables':
        return { title: 'Receivables Report', rows: [
          ['Customer', 'Partial invoices', 'Outstanding'],
          ...receivablesReport.byCustomer.map(c => [c.name, String(c.count), c.outstanding.toFixed(2)]),
          ['', '', ''],
          ['Total outstanding', '', receivablesReport.total.toFixed(2)],
        ]};
      case 'partner':
        return { title: 'Partner Report', rows: [
          ['Partner', 'Share %', 'Invested', 'Withdrawn', 'Profit share', 'Balance'],
          ...partnerReport.rows.map(r => [r.name, r.share.toFixed(2), r.invested.toFixed(2), r.withdrawn.toFixed(2), r.profitShare.toFixed(2), r.balance.toFixed(2)]),
          ['', '', '', '', '', ''],
          ['Total balance', '', '', '', '', partnerReport.totalBalance.toFixed(2)],
        ]};
    }
  }

  function handleExport(format: ExportFormat) {
    const { title, rows } = buildReportRows();
    const base = `report_${active}`;
    if (format === 'csv') downloadCsv(`${base}.csv`, rows);
    else if (format === 'xlsx') downloadExcel(`${base}.xls`, title, rows);
    else printPdf(title, rows);
  }

  return (
    <PageLayout
      title="Reports"
      subtitle="Structured business reports — Plan §Reports §A–§H"
      actions={
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => handleExport('pdf')}><Download size={14} /> PDF</Button>
          <Button variant="ghost" onClick={() => handleExport('xlsx')}><Download size={14} /> Excel</Button>
          <Button variant="primary" onClick={() => handleExport('csv')}><Download size={14} /> CSV</Button>
        </div>
      }
    >
      {/* Plan §Reports §6: Live vs Period Toggle */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="text-overline">MODE</span>
        {(['live', 'period'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 999, cursor: 'pointer',
            border: '1px solid ' + (mode === m ? '#0F0F10' : '#D5D1C4'),
            background: mode === m ? '#0F0F10' : 'transparent',
            color: mode === m ? '#FFFFFF' : '#6B7280',
          }}>{m === 'live' ? 'Live (all time)' : 'Period'}</button>
        ))}
      </div>

      {/* Plan §Reports §4: Filter — Datum / Kategorie / Kunde / Supplier / Status */}
      {mode === 'period' && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="text-overline">PERIOD</span>
          {(['today', 'week', 'month', 'year', 'all', 'custom'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '5px 10px', fontSize: 12, borderRadius: 999, cursor: 'pointer',
              border: '1px solid ' + (period === p ? '#0F0F10' : '#D5D1C4'),
              background: period === p ? '#0F0F10' : 'transparent',
              color: period === p ? '#FFFFFF' : '#6B7280',
            }}>{p === 'today' ? 'Today' : p === 'week' ? 'Week' : p === 'month' ? 'Month' : p === 'year' ? 'Year' : p === 'all' ? 'All' : 'Custom'}</button>
          ))}
          {period === 'custom' && (
            <>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ padding: '4px 8px', fontSize: 11, border: '1px solid #D5D1C4', borderRadius: 6 }} />
              <span style={{ fontSize: 11, color: '#6B7280' }}>→</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ padding: '4px 8px', fontSize: 11, border: '1px solid #D5D1C4', borderRadius: 6 }} />
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          style={{ padding: '5px 10px', fontSize: 11, border: '1px solid #D5D1C4', borderRadius: 6, background: '#FFFFFF' }}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)}
          style={{ padding: '5px 10px', fontSize: 11, border: '1px solid #D5D1C4', borderRadius: 6, background: '#FFFFFF' }}>
          <option value="">All customers</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>)}
        </select>
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}
          style={{ padding: '5px 10px', fontSize: 11, border: '1px solid #D5D1C4', borderRadius: 6, background: '#FFFFFF' }}>
          <option value="">All suppliers</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '5px 10px', fontSize: 11, border: '1px solid #D5D1C4', borderRadius: 6, background: '#FFFFFF' }}>
          <option value="">Any invoice status</option>
          <option value="FINAL">FINAL</option>
          <option value="PARTIAL">PARTIAL</option>
          <option value="DRAFT">DRAFT</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        {(categoryFilter || customerFilter || supplierFilter || statusFilter) && (
          <button onClick={() => { setCategoryFilter(''); setCustomerFilter(''); setSupplierFilter(''); setStatusFilter(''); }}
            style={{ fontSize: 11, color: '#6B7280', background: 'transparent', border: 'none', cursor: 'pointer' }}>Clear filters</button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, overflowX: 'auto', paddingBottom: 4 }}>
        {REPORTS.map(r => (
          <button key={r.key} onClick={() => setActive(r.key)}
            className="cursor-pointer rounded-full transition-all"
            style={{
              padding: '8px 16px', fontSize: 13, flexShrink: 0,
              border: `1px solid ${active === r.key ? '#0F0F10' : '#E5E1D6'}`,
              background: active === r.key ? '#0F0F10' : '#FFFFFF',
              color: active === r.key ? '#FFFFFF' : '#0F0F10',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <r.icon size={14} /> {r.label}
          </button>
        ))}
      </div>

      {active === 'sales' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            <MetricCard label="INVOICES (FINAL)" value={String(salesReport.count)} />
            <MetricCard label="GROSS REVENUE" value={`${fmt(salesReport.gross)} BHD`} />
            <MetricCard label="VAT COLLECTED" value={`${fmt(salesReport.vat)} BHD`} />
            <MetricCard label="NET REVENUE" value={`${fmt(salesReport.net)} BHD`} />
          </div>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>REVENUE BY MONTH</span>
            {Object.entries(salesReport.byMonth).sort().map(([m, v]) => (
              <div key={m} className="flex justify-between" style={{ padding: '8px 0', borderBottom: '1px solid #E5E1D6', fontSize: 13 }}>
                <span style={{ color: '#0F0F10' }}>{m}</span>
                <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(v)} BHD</span>
              </div>
            ))}
            {Object.keys(salesReport.byMonth).length === 0 && <p style={{ color: '#6B7280', fontSize: 13 }}>No FINAL invoices yet.</p>}
          </Card>
        </div>
      )}

      {active === 'profit' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <MetricCard label="GROSS PROFIT" value={`${fmt(profitReport.profit)} BHD`} />
            <MetricCard label="TOTAL COST" value={`${fmt(profitReport.cost)} BHD`} />
            <MetricCard label="MARGIN %" value={profitReport.margin.toFixed(1)} unit="%" />
          </div>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>FINAL INVOICES (Profit per Invoice)</span>
            {invoices.filter(i => i.status === 'FINAL').slice(0, 20).map(i => (
              <div key={i.id} className="flex justify-between" style={{ padding: '8px 0', borderBottom: '1px solid #E5E1D6', fontSize: 12 }}>
                <span className="font-mono" style={{ color: '#0F0F10' }}>{i.invoiceNumber}</span>
                <span style={{ color: '#6B7280' }}>Cost: {fmt(i.purchasePriceSnapshot || 0)}</span>
                <span className="font-mono" style={{ color: '#16A34A' }}>+{fmt(i.marginSnapshot || 0)} BHD</span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {active === 'tax' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <MetricCard label="VAT 10% (VISIBLE)" value={`${fmt(taxReport.vat10)} BHD`} />
            <MetricCard label="MARGIN VAT (INTERNAL)" value={`${fmt(taxReport.marginVat)} BHD`} />
            <MetricCard label="ZERO-RATED REVENUE" value={`${fmt(taxReport.zero)} BHD`} />
          </div>
          <Card>
            <p style={{ fontSize: 13, color: '#6B7280' }}>Plan §Tax: VAT 10% ist sichtbar auf Rechnung, Margin-VAT wird intern gerechnet (nicht sichtbar für Kunden), Zero ist 0%.</p>
          </Card>
        </div>
      )}

      {active === 'inventory' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            <MetricCard label="ITEMS IN STOCK" value={String(inventoryReport.count)} />
            <MetricCard label="STOCK VALUE (COST)" value={`${fmt(inventoryReport.value)} BHD`} />
          </div>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>STOCK BY CATEGORY</span>
            {inventoryReport.byCat.map(c => (
              <div key={c.name} className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E1D6', fontSize: 13 }}>
                <span style={{ color: '#0F0F10' }}>{c.name}</span>
                <div className="flex gap-6">
                  <span style={{ color: '#6B7280' }}>{c.count} items</span>
                  <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(c.value)} BHD</span>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {active === 'expense' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <MetricCard label="TOTAL EXPENSES" value={`${fmt(expenseReport.total)} BHD`} />
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>BY CATEGORY</span>
            {Object.entries(expenseReport.totals).map(([k, v]) => (
              <div key={k} className="flex justify-between" style={{ padding: '8px 0', borderBottom: '1px solid #E5E1D6', fontSize: 13 }}>
                <span style={{ color: '#0F0F10' }}>{k}</span>
                <span className="font-mono" style={{ color: '#DC2626' }}>{fmt(v)} BHD</span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {active === 'payables' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <MetricCard label="TOTAL OWED TO SUPPLIERS" value={`${fmt(payablesReport.total)} BHD`} />
          <Card>
            {payablesReport.bySupplier.length === 0
              ? <p style={{ fontSize: 13, color: '#6B7280' }}>No outstanding supplier balances.</p>
              : payablesReport.bySupplier.map(s => (
                <div key={s.name} className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E1D6', fontSize: 13 }}>
                  <span style={{ color: '#0F0F10' }}>{s.name}</span>
                  <div className="flex gap-6">
                    <span style={{ color: '#6B7280' }}>of {fmt(s.totalPurchases)} total</span>
                    <span className="font-mono" style={{ color: '#DC2626' }}>− {fmt(s.outstanding)} BHD</span>
                  </div>
                </div>
              ))}
          </Card>
        </div>
      )}

      {active === 'receivables' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <MetricCard label="TOTAL OUTSTANDING FROM CUSTOMERS" value={`${fmt(receivablesReport.total)} BHD`} />
          <Card>
            {receivablesReport.byCustomer.length === 0
              ? <p style={{ fontSize: 13, color: '#6B7280' }}>No open receivables.</p>
              : receivablesReport.byCustomer.map(c => (
                <div key={c.name} className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E1D6', fontSize: 13 }}>
                  <span style={{ color: '#0F0F10' }}>{c.name}</span>
                  <div className="flex gap-6">
                    <span style={{ color: '#6B7280' }}>{c.count} partial inv.</span>
                    <span className="font-mono" style={{ color: '#16A34A' }}>{fmt(c.outstanding)} BHD</span>
                  </div>
                </div>
              ))}
          </Card>
        </div>
      )}

      {active === 'partner' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <MetricCard label="TOTAL PARTNER CAPITAL" value={`${fmt(partnerReport.totalBalance)} BHD`} />
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>BY PARTNER</span>
            {partnerReport.rows.length === 0
              ? <p style={{ fontSize: 13, color: '#6B7280' }}>No partners yet.</p>
              : partnerReport.rows.map(r => (
                <div key={r.name} style={{ padding: '12px 0', borderBottom: '1px solid #E5E1D6' }}>
                  <div className="flex justify-between items-center" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 14, color: '#0F0F10' }}>{r.name}</span>
                    <span style={{ fontSize: 12, color: '#6B7280' }}>{r.share}% share</span>
                  </div>
                  <div className="flex gap-6" style={{ fontSize: 11, color: '#6B7280' }}>
                    <span>Invested: <span className="font-mono" style={{ color: '#16A34A' }}>{fmt(r.invested)}</span></span>
                    <span>Withdrawn: <span className="font-mono" style={{ color: '#DC2626' }}>{fmt(r.withdrawn)}</span></span>
                    <span>Profit: <span className="font-mono" style={{ color: '#16A34A' }}>{fmt(r.profitShare)}</span></span>
                    <span>Balance: <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(r.balance)} BHD</span></span>
                  </div>
                </div>
              ))}
          </Card>
        </div>
      )}
    </PageLayout>
  );
}

function MetricCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <Card>
      <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>{label}</span>
      <div className="font-display" style={{ fontSize: 28, color: '#0F0F10' }}>
        {value}
        {unit && <span style={{ fontSize: 14, color: '#6B7280', marginLeft: 6 }}>{unit}</span>}
      </div>
    </Card>
  );
}
