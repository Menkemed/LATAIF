import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, Package, Users, FileText, ShoppingCart, Plus, CreditCard, Wallet, AlertTriangle, Landmark, UserPlus, RefreshCw } from 'lucide-react';
import { useBankingStore } from '@/stores/bankingStore';
import { KPICard } from '@/components/ui/KPICard';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { VIPBadge } from '@/components/ui/VIPBadge';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useAuthStore } from '@/stores/authStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { usePartnerStore } from '@/stores/partnerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useDebtStore } from '@/stores/debtStore';
import { query } from '@/core/db/helpers';
import { getSpotPrices, type SpotPrice } from '@/core/market/spot-prices';

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function Dashboard() {
  const navigate = useNavigate();
  const { products, categories, loadProducts, loadCategories, getStockValue, getStockByCategory } = useProductStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { partners, loadPartners } = usePartnerStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  const { loadExpenses, getTotalsByCategory, expenses: allExpenses } = useExpenseStore();
  const { loadTransfers, getBalances } = useBankingStore();
  const { returns: salesReturns, loadReturns: loadSalesReturns } = useSalesReturnStore();
  const { debts, loadDebts } = useDebtStore();
  const userName = useAuthStore(s => s.session?.user.name || '');
  const firstName = userName.split(' ')[0] || userName;

  // Live Spot-Prices (Gold + Silber) — von gold-api.com, Cache 5 Min
  const [spotGold, setSpotGold] = useState<SpotPrice | undefined>();
  const [spotSilver, setSpotSilver] = useState<SpotPrice | undefined>();
  const [spotStale, setSpotStale] = useState(false);
  const [spotLoading, setSpotLoading] = useState(false);

  async function refreshSpot(force = false) {
    setSpotLoading(true);
    try {
      const res = await getSpotPrices(force);
      setSpotGold(res.gold);
      setSpotSilver(res.silver);
      setSpotStale(res.stale);
    } finally {
      setSpotLoading(false);
    }
  }

  useEffect(() => {
    refreshSpot(false);
    const t = setInterval(() => refreshSpot(false), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Plan §Dashboard §4: Zeitraumfilter — Heute / Woche / Monat / Jahr / Custom Range
  type Period = 'today' | 'week' | 'month' | 'year' | 'custom';
  const [period, setPeriod] = useState<Period>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const periodStart = useMemo(() => {
    const now = new Date();
    if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    if (period === 'week') { const d = new Date(now); d.setDate(now.getDate() - 7); return d.toISOString(); }
    if (period === 'month') { const d = new Date(now); d.setMonth(now.getMonth() - 1); return d.toISOString(); }
    if (period === 'year') { const d = new Date(now); d.setFullYear(now.getFullYear() - 1); return d.toISOString(); }
    if (period === 'custom') return customFrom || '1970-01-01';
    return '1970-01-01';
  }, [period, customFrom]);
  const periodEnd = useMemo(() => {
    if (period === 'custom' && customTo) return customTo + 'T23:59:59';
    return new Date().toISOString();
  }, [period, customTo]);

  useEffect(() => {
    loadCategories(); loadProducts(); loadCustomers();
    loadSuppliers(); loadPartners(); loadInvoices(); loadPurchases(); loadExpenses();
    loadTransfers(); loadSalesReturns(); loadDebts();
  }, [loadCategories, loadProducts, loadCustomers, loadSuppliers, loadPartners, loadInvoices, loadPurchases, loadExpenses, loadTransfers, loadSalesReturns, loadDebts]);

  const stock = useMemo(() => getStockValue(), [products, getStockValue]);
  const stockByCat = useMemo(() => getStockByCategory(), [products, categories, getStockByCategory]);
  const featured = useMemo(() => products.filter(p => p.stockStatus === 'in_stock').slice(0, 4), [products]);
  const topClients = useMemo(() => [...customers].sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 5), [customers]);

  // Plan §Sales §3: Revenue und Profit NUR aus FINAL invoices. Plan §Dashboard §4: Zeitraumfilter.
  const finalInvoices = useMemo(() => invoices.filter(i => {
    if (i.status !== 'FINAL') return false;
    const when = i.issuedAt || i.createdAt;
    if (!when) return true;
    return when >= periodStart && when <= periodEnd;
  }), [invoices, periodStart, periodEnd]);
  const totalRevenue = useMemo(() => finalInvoices.reduce((s, i) => s + i.grossAmount, 0), [finalInvoices]);
  const totalProfit = useMemo(() => finalInvoices.reduce((s, i) => s + (i.marginSnapshot || 0), 0), [finalInvoices]);
  // Plan §Dashboard §3.A+B: durchschnittlicher Verkauf + Margin %
  const avgSale = useMemo(() => finalInvoices.length > 0 ? totalRevenue / finalInvoices.length : 0, [finalInvoices, totalRevenue]);
  const marginPct = useMemo(() => totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0, [totalRevenue, totalProfit]);

  // Payables & Receivables (Plan §Dashboard §E)
  const supplierPayables = useMemo(
    () => suppliers.reduce((s, sup) => s + (sup.outstandingBalance || 0), 0),
    [suppliers]
  );
  const customerReceivables = useMemo(
    () => invoices.filter(i => i.status === 'PARTIAL').reduce((s, i) => s + Math.max(0, i.grossAmount - i.paidAmount), 0),
    [invoices]
  );
  const partnerCapital = useMemo(
    () => partners.reduce((s, p) => s + (p.balance || 0), 0),
    [partners]
  );

  // Plan §Dashboard §3.D: Cash & Bank — präzise aus bankingStore (alle Transaction-Types) +
  // Opening-Balances aus Settings.
  const accountBalances = useMemo(() => {
    try {
      const settingsRows = query(
        `SELECT key, value FROM settings WHERE key = 'finance.opening_cash' OR key = 'finance.opening_bank'`,
        []
      );
      let cash = 0, bank = 0;
      for (const r of settingsRows) {
        const v = parseFloat((r.value as string) || '0') || 0;
        if (r.key === 'finance.opening_cash') cash = v;
        else if (r.key === 'finance.opening_bank') bank = v;
      }
      const live = getBalances();
      return { cash: cash + live.cash, bank: bank + live.bank };
    } catch {
      return { cash: 0, bank: 0 };
    }
  }, [getBalances, invoices, purchases, allExpenses]);

  // Plan §Dashboard §3.F: Total + Monthly + Top Kategorien
  const expenseTotals = getTotalsByCategory();
  const totalExpenses = Object.values(expenseTotals).reduce((s, v) => s + v, 0);
  const topExpenseCats = useMemo(() =>
    Object.entries(expenseTotals)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3),
    [expenseTotals]
  );
  const monthlyExpenses = useMemo(() => {
    const prefix = new Date().toISOString().slice(0, 7);
    return allExpenses.filter(e => (e.expenseDate || '').startsWith(prefix)).reduce((s, e) => s + e.amount, 0);
  }, [allExpenses]);

  // Plan §Dashboard §3.G: Partner Capital + offene Auszahlung + Gewinnanteile
  const partnerOpenWithdrawal = useMemo(() =>
    partners.reduce((s, p) => s + Math.max(0, -(p.balance || 0)), 0),
    [partners]
  );
  const partnerProfitShare = useMemo(() => {
    const totalShare = partners.reduce((s, p) => s + (p.sharePercentage || 0), 0);
    if (totalShare <= 0) return 0;
    return totalProfit * (totalShare / 100);
  }, [partners, totalProfit]);

  // Alerts (Plan §Dashboard §7)
  const alerts: Array<{ key: string; level: 'urgent' | 'warn' | 'info'; text: string }> = [];
  if (customerReceivables > 0) {
    alerts.push({ key: 'open-inv', level: 'warn', text: `${fmt(customerReceivables)} BHD outstanding from customers (${invoices.filter(i => i.status === 'PARTIAL').length} invoices)` });
  }
  if (supplierPayables > 0) {
    alerts.push({ key: 'sup-debt', level: 'warn', text: `${fmt(supplierPayables)} BHD owed to suppliers` });
  }
  if (accountBalances.cash + accountBalances.bank < 1000) {
    alerts.push({ key: 'low-cash', level: 'urgent', text: 'Cash + Bank below 1,000 BHD' });
  }

  const openPurchases = purchases.filter(p => p.status === 'UNPAID' || p.status === 'PARTIALLY_PAID').length;

  // Plan §Dashboard Fix — offene Refund-Schuld an Kunden + offene Forderungen/Verbindlichkeiten aus Loans.
  const outstandingRefunds = useMemo(() =>
    salesReturns
      .filter(r => r.status !== 'REJECTED')
      .reduce((s, r) => s + Math.max(0, (r.totalAmount || 0) - (r.refundPaidAmount || 0)), 0),
    [salesReturns]
  );
  const openRefundCount = useMemo(() =>
    salesReturns.filter(r => r.status !== 'REJECTED' && (r.totalAmount || 0) - (r.refundPaidAmount || 0) > 0.001).length,
    [salesReturns]
  );
  const openOwedToUs = useMemo(() =>
    debts
      .filter(d => d.direction === 'MONEY_GIVEN' && (d.status === 'OPEN' || d.status === 'PARTIALLY_REPAID'))
      .reduce((s, d) => s + Math.max(0, (d.amount || 0) - (d.paidAmount || 0)), 0),
    [debts]
  );
  const openWeOwe = useMemo(() =>
    debts
      .filter(d => d.direction === 'MONEY_RECEIVED' && (d.status === 'OPEN' || d.status === 'PARTIALLY_REPAID'))
      .reduce((s, d) => s + Math.max(0, (d.amount || 0) - (d.paidAmount || 0)), 0),
    [debts]
  );

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Find category for a product
  const getCat = (catId: string) => categories.find(c => c.id === catId);

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '48px 48px 64px', maxWidth: 1400 }}>

        {/* Greeting + Quick Actions */}
        <div className="flex items-baseline justify-between animate-fade-in" style={{ marginBottom: 24 }}>
          <h1 className="text-display-m" style={{ color: '#0F0F10' }}>
            {getGreeting()}{firstName ? ', ' : ''}<span style={{ color: '#0F0F10' }}>{firstName}</span>
          </h1>
          <span style={{ fontSize: 13, color: '#6B7280' }}>{today}</span>
        </div>

        {/* Plan §Dashboard §6: Quick Actions */}
        <div className="flex gap-2 animate-fade-in" style={{ marginBottom: 32, flexWrap: 'wrap' }}>
          {[
            { label: 'New Sale', icon: Plus, to: '/invoices' },
            { label: 'New Purchase', icon: ShoppingCart, to: '/purchases' },
            { label: 'Add Expense', icon: Wallet, to: '/expenses' },
            { label: 'Add Payment', icon: CreditCard, to: '/invoices' },
            { label: 'Transfer', icon: Landmark, to: '/banking' },
            { label: 'Partners', icon: UserPlus, to: '/partners' },
          ].map(a => (
            <button key={a.label} onClick={() => navigate(a.to)}
              className="cursor-pointer rounded-full transition-all"
              style={{
                padding: '8px 16px', fontSize: 12,
                background: '#FFFFFF', border: '1px solid #E5E1D6',
                color: '#0F0F10', display: 'flex', alignItems: 'center', gap: 6,
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E1D6')}
            >
              <a.icon size={14} /> {a.label}
            </button>
          ))}
        </div>

        {/* Live Spot-Prices (Gold + Silber) — Quelle: gold-api.com, Cache 5 Min */}
        <div className="animate-fade-in" style={{
          marginBottom: 28, padding: '18px 22px', borderRadius: 12,
          background: 'linear-gradient(135deg, #1A1A1F 0%, #08080A 100%)',
          border: '1px solid #2A2A30',
          display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 24, alignItems: 'center',
        }}>
          {/* Gold */}
          <div>
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#C6A36D' }} />
              <span style={{ fontSize: 11, color: '#8E8E97', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Gold (XAU) Spot</span>
            </div>
            {spotGold ? (
              <div>
                <div className="font-display" style={{ fontSize: 22, color: '#C6A36D', lineHeight: 1.1 }}>
                  {spotGold.bhdPerGram.toFixed(3)} <span style={{ fontSize: 12, color: '#8E8E97' }}>BHD/g</span>
                </div>
                <div className="font-mono" style={{ fontSize: 11, color: '#6B6B73', marginTop: 4 }}>
                  ${spotGold.usdPerOunce.toFixed(2)} /oz · ${spotGold.usdPerGram.toFixed(2)} /g
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#6B6B73' }}>{spotLoading ? 'Loading…' : 'Unavailable'}</div>
            )}
          </div>

          {/* Silber */}
          <div>
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#B0B0B5' }} />
              <span style={{ fontSize: 11, color: '#8E8E97', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Silver (XAG) Spot</span>
            </div>
            {spotSilver ? (
              <div>
                <div className="font-display" style={{ fontSize: 22, color: '#E5E1D6', lineHeight: 1.1 }}>
                  {spotSilver.bhdPerGram.toFixed(3)} <span style={{ fontSize: 12, color: '#8E8E97' }}>BHD/g</span>
                </div>
                <div className="font-mono" style={{ fontSize: 11, color: '#6B6B73', marginTop: 4 }}>
                  ${spotSilver.usdPerOunce.toFixed(2)} /oz · ${spotSilver.usdPerGram.toFixed(2)} /g
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#6B6B73' }}>{spotLoading ? 'Loading…' : 'Unavailable'}</div>
            )}
          </div>

          {/* Refresh + Status */}
          <div style={{ textAlign: 'right' }}>
            <button onClick={() => refreshSpot(true)} disabled={spotLoading}
              className="cursor-pointer flex items-center gap-1"
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 11,
                background: 'transparent', border: '1px solid #3D3D45',
                color: '#8E8E97',
              }}>
              <RefreshCw size={12} className={spotLoading ? 'animate-spin' : ''} />
              {spotLoading ? 'Loading' : 'Refresh'}
            </button>
            <div style={{ fontSize: 10, color: '#6B6B73', marginTop: 6 }}>
              {spotStale ? 'Cached (offline)' : (spotGold || spotSilver) ? `Updated ${new Date((spotGold || spotSilver)!.fetchedAt).toLocaleTimeString()}` : ''}
            </div>
          </div>
        </div>

        {/* Alerts (Plan §Dashboard §7) */}
        {alerts.length > 0 && (
          <div className="animate-fade-in" style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {alerts.map(a => (
              <div key={a.key} style={{
                padding: '10px 14px', borderRadius: 8,
                background: a.level === 'urgent' ? 'rgba(220,38,38,0.06)' : a.level === 'warn' ? 'rgba(217,119,6,0.06)' : 'rgba(37,99,235,0.06)',
                border: `1px solid ${a.level === 'urgent' ? 'rgba(220,38,38,0.2)' : a.level === 'warn' ? 'rgba(217,119,6,0.2)' : 'rgba(37,99,235,0.2)'}`,
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <AlertTriangle size={14} style={{ color: a.level === 'urgent' ? '#DC2626' : a.level === 'warn' ? '#D97706' : '#2563EB', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: '#0F0F10' }}>{a.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* Plan §Dashboard §4: Zeitraumfilter — Heute / Woche / Monat / Jahr / Custom Range */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="text-overline">PERIOD</span>
          {(['today', 'week', 'month', 'year', 'custom'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '5px 12px', fontSize: 12, borderRadius: 999, cursor: 'pointer',
              border: '1px solid ' + (period === p ? '#0F0F10' : '#D5D1C4'),
              background: period === p ? '#0F0F10' : 'transparent',
              color: period === p ? '#FFFFFF' : '#6B7280',
            }}>{p === 'today' ? 'Today' : p === 'week' ? 'Week' : p === 'month' ? 'Month' : p === 'year' ? 'Year' : 'Custom'}</button>
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

        {/* KPI Row 1 — Plan §Dashboard §A+§B: Revenue/Profit/Avg/Margin */}
        <div className="animate-fade-in animate-stagger-2"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 24 }}>
          <KPICard label="REVENUE (FINAL)" value={fmt(totalRevenue)} unit={`BHD · ${finalInvoices.length} inv.`} icon={<TrendingUp size={16} />} accent="lime" onClick={() => navigate('/invoices?filter=FINAL')} />
          <KPICard label="PROFIT" value={fmt(totalProfit)} unit={`BHD · ${marginPct.toFixed(1)}% margin`} icon={<TrendingUp size={16} />} onClick={() => navigate('/reports')} />
          <KPICard label="AVG SALE" value={fmt(avgSale)} unit="BHD per invoice" icon={<FileText size={16} />} onClick={() => navigate('/invoices')} />
          <KPICard label="STOCK VALUE" value={fmt(stock.purchaseTotal)} unit={`BHD · ${stock.count} items (OWN)`} icon={<Package size={16} />} accent="mint" onClick={() => navigate('/collection')} />
        </div>

        {/* KPI Row 2 — Cash/Bank/Receivables/Payables */}
        <div className="animate-fade-in"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 24 }}>
          <KPICard label="CASH" value={fmt(accountBalances.cash)} unit="BHD" icon={<Wallet size={16} />} onClick={() => navigate('/banking')} />
          <KPICard label="BANK" value={fmt(accountBalances.bank)} unit="BHD" icon={<Landmark size={16} />} onClick={() => navigate('/banking')} />
          <KPICard label="RECEIVABLES" value={fmt(customerReceivables)} unit={`BHD · ${invoices.filter(i => i.status === 'PARTIAL').length} partial inv.`} icon={<FileText size={16} />} onClick={() => navigate('/invoices?filter=PARTIAL')} />
          <KPICard label="SUPPLIER PAYABLES" value={fmt(supplierPayables)} unit={`BHD · ${openPurchases} open`} icon={<ShoppingCart size={16} />} onClick={() => navigate('/purchases?filter=UNPAID')} />
        </div>

        {/* KPI Row 3 — Open Refunds + Debts (Plan §Dashboard Fix) */}
        <div className="animate-fade-in"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 24 }}>
          <KPICard label="REFUND PAYABLE" value={fmt(outstandingRefunds)} unit={`BHD · ${openRefundCount} open returns`}
            icon={<FileText size={16} />} accent={outstandingRefunds > 0 ? 'urgent' : 'none'}
            onClick={() => navigate('/invoices?filter=returns')} />
          <KPICard label="OWED TO US" value={fmt(openOwedToUs)} unit="BHD · open loans given"
            icon={<TrendingUp size={16} />}
            onClick={() => navigate('/debts?direction=MONEY_GIVEN')} />
          <KPICard label="WE OWE" value={fmt(openWeOwe)} unit="BHD · open loans received"
            icon={<AlertTriangle size={16} />} accent={openWeOwe > 0 ? 'urgent' : 'none'}
            onClick={() => navigate('/debts?direction=MONEY_RECEIVED')} />
          <KPICard label="MONTHLY EXPENSES" value={fmt(monthlyExpenses)} unit={`BHD · ${fmt(totalExpenses)} total`}
            icon={<Wallet size={16} />} onClick={() => navigate('/expenses')} />
        </div>

        {/* KPI Row 4 — Partner */}
        <div className="animate-fade-in"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 24 }}>
          <KPICard label="PARTNER CAPITAL" value={fmt(partnerCapital)} unit={`BHD · ${partners.length} partners`} icon={<UserPlus size={16} />} onClick={() => navigate('/partners')} />
          <KPICard label="OPEN PARTNER PAYOUT" value={fmt(partnerOpenWithdrawal)} unit="BHD" icon={<UserPlus size={16} />} onClick={() => navigate('/partners')} />
          <KPICard label="PARTNER PROFIT SHARE" value={fmt(partnerProfitShare)} unit="BHD period" icon={<TrendingUp size={16} />} onClick={() => navigate('/partners')} />
          <KPICard label="CUSTOMERS" value={fmt(customers.length)} unit={`${customers.filter(c => c.salesStage === 'active').length} active`} icon={<Users size={16} />} onClick={() => navigate('/clients')} />
        </div>

        {/* Plan §Dashboard §F: Top Expense Categories */}
        {topExpenseCats.length > 0 && (
          <div style={{ marginBottom: 40, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            {topExpenseCats.map(([cat, v]) => (
              <div key={cat} style={{ padding: '14px 18px', background: '#FFFFFF', border: '1px solid #E5E1D6', borderRadius: 10 }}>
                <div style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
                  Top expense · {cat}
                </div>
                <div className="font-mono" style={{ fontSize: 18, color: '#0F0F10' }}>{fmt(v)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span></div>
              </div>
            ))}
          </div>
        )}

        {/* Stock by Category */}
        {stockByCat.length > 0 && (
          <div className="animate-fade-in animate-stagger-3" style={{ marginBottom: 40 }}>
            <span className="text-overline" style={{ marginBottom: 16 }}>STOCK BY CATEGORY</span>
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              {stockByCat.map(cat => (
                <div
                  key={cat.categoryId}
                  className="rounded-lg cursor-pointer transition-all duration-200"
                  style={{
                    padding: '14px 20px',
                    background: '#FFFFFF',
                    border: '1px solid #E5E1D6',
                    display: 'flex', alignItems: 'center', gap: 12,
                  }}
                  onClick={() => navigate('/collection')}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = cat.color)}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#E5E1D6')}
                >
                  <span className="rounded-full" style={{ width: 8, height: 8, background: cat.color }} />
                  <span style={{ fontSize: 13, color: '#0F0F10' }}>{cat.name}</span>
                  <span className="font-mono" style={{ fontSize: 13, color: '#4B5563' }}>{cat.count}</span>
                  <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>{fmt(cat.value)} BHD</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Featured Collection */}
        {featured.length > 0 && (
          <div className="animate-fade-in animate-stagger-3" style={{ marginBottom: 56 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 24 }}>
              <span className="text-overline">FEATURED FROM COLLECTION</span>
              <button onClick={() => navigate('/collection')}
                className="cursor-pointer transition-colors"
                style={{ fontSize: 13, color: '#6B7280', background: 'none', border: 'none' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
                onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
              >view all &rarr;</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20 }}>
              {featured.map(p => {
                const cat = getCat(p.categoryId);
                return (
                  <Card key={p.id} hoverable noPadding onClick={() => navigate(`/collection/${p.id}`)}>
                    <div className="flex items-center justify-center relative"
                      style={{ height: 160, background: '#EFECE2', borderBottom: '1px solid #E5E1D6', overflow: 'hidden' }}>
                      {p.images.length > 0 ? (
                        <img src={p.images[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <Package size={32} strokeWidth={1} style={{ color: '#6B7280' }} />
                      )}
                      {cat && (
                        <span className="absolute" style={{
                          top: 10, left: 10, fontSize: 10, padding: '2px 8px', borderRadius: 999,
                          background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                        }}>{cat.name}</span>
                      )}
                    </div>
                    <div style={{ padding: '16px 20px 20px' }}>
                      <span className="text-overline">{p.brand}</span>
                      <h3 className="font-display" style={{ fontSize: 17, color: '#0F0F10', marginTop: 4, lineHeight: 1.3 }}>{p.name}</h3>
                      <div className="flex items-center justify-between" style={{ marginTop: 14 }}>
                        <span>
                          <span className="font-display" style={{ fontSize: 17, color: '#0F0F10' }}>{fmt(p.plannedSalePrice || p.purchasePrice)}</span>
                          <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 3 }}>BHD</span>
                        </span>
                        <StatusDot status={p.stockStatus} />
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* Bottom Row */}
        <div className="animate-fade-in animate-stagger-4"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

          {/* Top Clients */}
          <Card>
            <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
              <span className="text-overline">TOP CLIENTS</span>
              <button onClick={() => navigate('/clients')}
                className="cursor-pointer transition-colors"
                style={{ fontSize: 13, color: '#6B7280', background: 'none', border: 'none' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
                onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
              >view all &rarr;</button>
            </div>
            {topClients.length === 0 && (
              <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No clients yet.</p>
            )}
            {topClients.map(c => (
              <div key={c.id} className="flex items-center justify-between cursor-pointer rounded-md transition-colors"
                style={{ padding: '12px 8px', margin: '0 -8px' }}
                onClick={() => navigate(`/clients/${c.id}`)}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(26,26,31,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center rounded-full shrink-0"
                    style={{ width: 36, height: 36, background: '#E5E1D6', border: '1px solid #D5D1C4', fontSize: 11, color: '#4B5563', fontWeight: 500 }}>
                    {c.firstName[0]}{c.lastName[0]}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span style={{ fontSize: 14, color: '#0F0F10' }}>{c.firstName} {c.lastName}</span>
                      <VIPBadge level={c.vipLevel} />
                    </div>
                    <span style={{ fontSize: 11, color: '#6B7280' }}>{c.purchaseCount} purchases</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(c.totalRevenue)}</div>
                  <div style={{ fontSize: 11, color: '#6B7280' }}>BHD</div>
                </div>
              </div>
            ))}
          </Card>

          {/* Quick Stats */}
          <Card>
            <span className="text-overline" style={{ marginBottom: 20 }}>QUICK OVERVIEW</span>
            {[
              { icon: <Users size={16} />, label: 'Total Clients', value: String(customers.length) },
              { icon: <Package size={16} />, label: 'Items in Stock', value: String(stock.count) },
              { icon: <TrendingUp size={16} />, label: 'Planned Stock Value', value: `${fmt(stock.saleTotal)} BHD` },
              { icon: <FileText size={16} />, label: 'Expected Margin', value: `${fmt(stock.saleTotal - stock.purchaseTotal)} BHD`, color: '#7EAA6E' },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between"
                style={{ padding: '16px 0', borderBottom: i < 3 ? '1px solid #E5E1D6' : 'none' }}>
                <div className="flex items-center gap-3">
                  <span style={{ color: '#6B7280' }}>{item.icon}</span>
                  <span style={{ fontSize: 14, color: '#4B5563' }}>{item.label}</span>
                </div>
                <span className="font-mono" style={{ fontSize: 15, color: item.color || '#0F0F10' }}>{item.value}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
