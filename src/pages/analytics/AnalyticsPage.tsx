import { useState, useEffect } from 'react';
import {
  TrendingUp, Package, Users, FileText,
  DollarSign, Clock, BarChart3, PieChart,
  Wallet, Building2, CheckCircle2, Smartphone,
} from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { KPICard } from '@/components/ui/KPICard';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { currentBranchId } from '@/core/db/helpers';
// CENTRAL-UI-PARITY R2C — die Zahlen kommen aus dem gemeinsamen Bestand, nicht mehr aus
// fünfzig Abfragen in dieser Datei.
import { useAnalyticsStore } from '@/stores/analyticsStore';
// Zwei reine Helfer, die die Anzeige mit der Rechnung teilt — eine Definition, kein Nachbau.
import { num, safeDiv } from '@/core/reports/analytics-snapshot';
import { readsFromPrimary } from '@/core/data/primary-source';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { exportCsv } from '@/core/utils/export-file';

// ── Helpers ──

type Tab = 'sales' | 'stock' | 'finance' | 'clients';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDec(v: number, digits = 1): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(v: number): string {
  return fmtDec(v) + '%';
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '10px 24px',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '0.04em',
  color: active ? '#0F0F10' : '#6B7280',
  background: active ? 'rgba(15,15,16,0.08)' : 'transparent',
  border: `1px solid ${active ? 'rgba(15,15,16,0.15)' : '#E5E9EE'}`,
  borderRadius: 8,
  cursor: 'pointer',
  transition: 'all 0.2s',
});

// ── Section header ──

function SectionLabel({ children }: { children: string }) {
  return (
    <span
      className="text-overline"
      style={{ display: 'block', marginBottom: 16, marginTop: 8 }}
    >
      {children}
    </span>
  );
}

// ── Table row helper ──

function TableRow({
  label,
  value,
  sub,
  color,
  bold,
  borderBottom = true,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  bold?: boolean;
  borderBottom?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: '14px 0',
        borderBottom: borderBottom ? '1px solid #E5E9EE' : 'none',
      }}
    >
      <span style={{ fontSize: 14, color: '#4B5563', fontWeight: bold ? 600 : 400 }}>
        {label}
      </span>
      <div className="text-right">
        <span
          className="font-mono"
          style={{ fontSize: 14, color: color || '#0F0F10', fontWeight: bold ? 600 : 400 }}
        >
          {value}
        </span>
        {sub && (
          <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>{sub}</span>
        )}
      </div>
    </div>
  );
}

// ── Ranked list item ──

function RankedItem({
  rank,
  label,
  value,
  sub,
  color,
}: {
  rank: number;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: '12px 0', borderBottom: '1px solid #E5E9EE' }}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex items-center justify-center rounded-full font-mono"
          style={{
            width: 28,
            height: 28,
            background: '#E5E9EE',
            fontSize: 11,
            color: '#4B5563',
            flexShrink: 0,
          }}
        >
          {rank}
        </span>
        <span style={{ fontSize: 14, color: '#0F0F10' }}>{label}</span>
      </div>
      <div className="text-right">
        <span className="font-mono" style={{ fontSize: 14, color: color || '#0F0F10' }}>
          {value}
        </span>
        {sub && <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>{sub}</span>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════

export function AnalyticsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('sales');
  const [branchId, setBranchId] = useState<string>('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Tax payment modal state
  const [taxPayQuarter, setTaxPayQuarter] = useState<{ year: number; quarter: number; vat: number; paid: number } | null>(null);
  const [taxPayAmount, setTaxPayAmount] = useState('');
  const [taxPayDate, setTaxPayDate] = useState('');
  const [taxPaySource, setTaxPaySource] = useState<'cash' | 'bank'>('bank');
  const [taxPayNote, setTaxPayNote] = useState('');

  useEffect(() => {
    try {
      setBranchId(currentBranchId());
    } catch {
      setBranchId('branch-main');
    }
  }, []);

  useEffect(() => {
    if (taxPayQuarter) {
      setTaxPayAmount((taxPayQuarter.vat - taxPayQuarter.paid).toFixed(3));
      setTaxPayDate(new Date().toISOString().split('T')[0]);
      setTaxPaySource('bank');
      setTaxPayNote('');
    }
  }, [taxPayQuarter]);

  function confirmTaxPayment() {
    if (!taxPayQuarter) return;
    const amt = parseFloat(taxPayAmount);
    if (!amt || amt <= 0) return;
    const now = new Date().toISOString();
    try {
      const db = getDatabase();
      db.run(
        `INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), branchId, taxPayQuarter.year, taxPayQuarter.quarter, amt, taxPaySource, taxPayDate + 'T00:00:00Z', taxPayNote || null, now]
      );
      saveDatabase();
    } catch (e) {
      console.warn('Tax payment save failed', e);
    }
    setTaxPayQuarter(null);
    setRefreshTick(t => t + 1);
  }

  // ── DATEN ──
  //
  // CENTRAL-UI-PARITY R2C — die Rechnung steht nicht mehr hier, sondern in einer gemeinsamen,
  // zustandsfreien Ladefunktion. Am Primary rechnet sie aus der eigenen Datenbank; auf einem
  // Rechner ohne Datenbank kommt dasselbe Ergebnis als EINE Auskunft vom Primary. Die Seite
  // sieht keinen Unterschied — sie bekommt in beiden Fällen dieselben vier Blöcke.
  const { snapshot, loadAnalytics, vatExportRows } = useAnalyticsStore();
  useEffect(() => { loadAnalytics(); }, [loadAnalytics, refreshTick]);
  const sales = snapshot?.sales ?? null;
  const stock = snapshot?.stock ?? null;
  const finance = snapshot?.finance ?? null;
  const clients = snapshot?.clients ?? null;

  // ── RENDER ──

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'sales', label: 'SALES', icon: <TrendingUp size={14} /> },
    { key: 'stock', label: 'STOCK', icon: <Package size={14} /> },
    { key: 'finance', label: 'FINANCE', icon: <DollarSign size={14} /> },
    { key: 'clients', label: 'CLIENTS', icon: <Users size={14} /> },
  ];

  const statusLabels: Record<string, string> = {
    in_stock: 'In Stock',
    reserved: 'Reserved',
    offered: 'Offered',
    sold: 'Sold',
    with_agent: 'With Agent',
    in_repair: 'In Repair',
    consignment: 'Consignment',
    on_order: 'On Order',
    write_off: 'Write-Off',
  };

  const statusColors: Record<string, string> = {
    in_stock: '#7EAA6E',
    reserved: '#0F0F10',
    offered: '#4B5563',
    sold: '#6B9EDB',
    with_agent: '#C9896E',
    in_repair: '#AA6E6E',
    consignment: '#9B7ECB',
    on_order: '#6B7280',
    write_off: '#AA6E6E',
  };

  const vipLabels: Record<number, string> = {
    0: 'Standard',
    1: 'Silver',
    2: 'Gold',
    3: 'Platinum',
  };

  const vipColors: Record<number, string> = {
    0: '#6B7280',
    1: '#4B5563',
    2: '#0F0F10',
    3: '#0F0F10',
  };

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10"
        style={{
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #E5E9EE',
        }}
      >
        <div style={{ padding: '24px 48px' }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
            <div>
              <h1 className="text-display-s" style={{ color: '#0F0F10' }}>Analytics</h1>
              <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
                Key performance indicators and business insights
              </p>
            </div>
            <div className="flex items-center gap-2">
              <BarChart3 size={16} style={{ color: '#6B7280' }} />
              <span style={{ fontSize: 12, color: '#6B7280' }}>
                {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-8" style={{ marginTop: 4 }}>
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={tabStyle(activeTab === tab.key)}
                className="flex items-center gap-2 transition-all"
                onMouseEnter={e => {
                  if (activeTab !== tab.key) {
                    e.currentTarget.style.color = '#0F0F10';
                    e.currentTarget.style.borderColor = '#D5D9DE';
                  }
                }}
                onMouseLeave={e => {
                  if (activeTab !== tab.key) {
                    e.currentTarget.style.color = '#6B7280';
                    e.currentTarget.style.borderColor = '#E5E9EE';
                  }
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="animate-fade-in" style={{ padding: '32px 48px 64px', maxWidth: 1400 }}>

        {/* ════════════════ SALES DASHBOARD ════════════════ */}
        {activeTab === 'sales' && sales && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="TOTAL REVENUE"
                value={fmt(sales.grossRevenue)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
              <KPICard
                label="TOTAL PROFIT"
                value={fmt(sales.totalProfit)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
              <KPICard
                label="PROFIT MARGIN"
                value={pct(sales.marginPct)}
                icon={<PieChart size={16} />}
              />
              <KPICard
                label="AVG SALE VALUE"
                value={fmt(sales.avgSaleValue)}
                unit="BHD"
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* Second KPI Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="OFFERS"
                value={sales.offerCount}
                unit="total offers"
                icon={<FileText size={16} />}
              />
              <KPICard
                label="INVOICES"
                value={sales.invoiceCount}
                unit="total invoices"
                icon={<FileText size={16} />}
              />
              <KPICard
                label="CLOSE RATE"
                value={pct(sales.closeRate)}
                unit="accepted / total offers"
                icon={<TrendingUp size={16} />}
              />
            </div>

            {/* Revenue by Category + Top Brands */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Card>
                <SectionLabel>REVENUE BY CATEGORY</SectionLabel>
                {sales.revByCat.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No sales data yet.</p>
                )}
                {sales.revByCat.map((cat, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between"
                    style={{
                      padding: '14px 0',
                      borderBottom: i < sales.revByCat.length - 1 ? '1px solid #E5E9EE' : 'none',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="rounded-full"
                        style={{
                          width: 8,
                          height: 8,
                          background: (cat.color as string) || '#0F0F10',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: 14, color: '#0F0F10' }}>{cat.name as string}</span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>
                        {num(cat, 'cnt')} items
                      </span>
                    </div>
                    <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>
                      {fmt(num(cat, 'revenue'))} <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
                    </span>
                  </div>
                ))}
              </Card>

              <Card>
                <SectionLabel>TOP 5 SELLING BRANDS</SectionLabel>
                {sales.topBrands.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No sales data yet.</p>
                )}
                {sales.topBrands.map((b, i) => (
                  <RankedItem
                    key={i}
                    rank={i + 1}
                    label={b.brand as string}
                    value={`${fmt(num(b, 'revenue'))} BHD`}
                    sub={`${num(b, 'cnt')} sold`}
                  />
                ))}
              </Card>
            </div>
          </div>
        )}

        {/* ════════════════ STOCK DASHBOARD ════════════════ */}
        {activeTab === 'stock' && stock && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="STOCK VALUE (EK)"
                value={fmt(stock.totalEK)}
                unit="BHD purchase cost"
                icon={<Package size={16} />}
              />
              <KPICard
                label="STOCK VALUE (VK)"
                value={fmt(stock.totalVK)}
                unit="BHD planned sale"
                icon={<DollarSign size={16} />}
              />
              <KPICard
                label="ITEMS IN STOCK"
                value={stock.totalItems}
                unit="items"
                icon={<Package size={16} />}
              />
              <KPICard
                label="EXPECTED MARGIN"
                value={fmt(stock.totalVK - stock.totalEK)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
            </div>

            {/* Second Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="SLOW MOVERS"
                value={stock.slowCount}
                unit="> 90 days in stock"
                icon={<Clock size={16} />}
              />
              <KPICard
                label="AVG DAYS IN STOCK"
                value={fmtDec(stock.avgDaysInStock, 0)}
                unit="days"
                icon={<Clock size={16} />}
              />
              <KPICard
                label="POTENTIAL PROFIT"
                value={pct(safeDiv(stock.totalVK - stock.totalEK, stock.totalEK) * 100)}
                unit="margin on current stock"
                icon={<PieChart size={16} />}
              />
            </div>

            {/* By Category + By Status */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Card>
                <SectionLabel>ITEMS BY CATEGORY</SectionLabel>
                {stock.byCat.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No stock data.</p>
                )}
                {stock.byCat.map((cat, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between"
                    style={{
                      padding: '14px 0',
                      borderBottom: i < stock.byCat.length - 1 ? '1px solid #E5E9EE' : 'none',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="rounded-full"
                        style={{
                          width: 8,
                          height: 8,
                          background: (cat.color as string) || '#0F0F10',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: 14, color: '#0F0F10' }}>{cat.name as string}</span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>
                        {num(cat, 'cnt')} items
                      </span>
                    </div>
                    <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>
                      {fmt(num(cat, 'value'))} <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
                    </span>
                  </div>
                ))}
              </Card>

              <Card>
                <SectionLabel>STATUS BREAKDOWN</SectionLabel>
                {stock.byStatus.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No products.</p>
                )}
                {stock.byStatus.map((s, i) => {
                  const status = s.stock_status as string;
                  const count = num(s, 'cnt');
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between"
                      style={{
                        padding: '14px 0',
                        borderBottom: i < stock.byStatus.length - 1 ? '1px solid #E5E9EE' : 'none',
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="rounded-full"
                          style={{
                            width: 8,
                            height: 8,
                            background: statusColors[status] || '#6B7280',
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: 14, color: '#0F0F10' }}>
                          {statusLabels[status] || status}
                        </span>
                      </div>
                      <span className="font-mono" style={{ fontSize: 14, color: statusColors[status] || '#0F0F10' }}>
                        {count}
                      </span>
                    </div>
                  );
                })}
              </Card>
            </div>
          </div>
        )}

        {/* ════════════════ FINANCE DASHBOARD ════════════════ */}
        {activeTab === 'finance' && finance && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="NET REVENUE"
                value={fmt(finance.netRevenue)}
                unit="BHD"
                icon={<DollarSign size={16} />}
              />
              <KPICard
                label="GROSS REVENUE"
                value={fmt(finance.grossRevenue)}
                unit="BHD incl. VAT"
                icon={<DollarSign size={16} />}
              />
              <KPICard
                label={finance.vatRefundDue > 0 ? 'VAT REFUND DUE' : 'NET VAT OWED'}
                value={fmt(finance.vatRefundDue > 0 ? finance.vatRefundDue : finance.netVatOwed)}
                unit={finance.vatRefundDue > 0
                  ? `Input ${fmt(finance.totalInputVat)} > Output ${fmt(finance.totalVat)} BHD — NBR schuldet uns`
                  : `Output ${fmt(finance.totalVat)} − Input ${fmt(finance.totalInputVat)} BHD`}
                icon={<FileText size={16} />}
              />
              <KPICard
                label="PROFIT AFTER VAT"
                value={fmt(finance.profitAfterVat)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
            </div>

            {/* Invoice Status Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="OPEN INVOICES"
                value={finance.openCount}
                unit={`${fmt(finance.openValue)} BHD outstanding`}
                icon={<Clock size={16} />}
              />
              <KPICard
                label="PAID INVOICES"
                value={finance.paidCount}
                unit={`${fmt(finance.paidValue)} BHD collected`}
                icon={<FileText size={16} />}
              />
              <KPICard
                label="OUTSTANDING"
                value={fmt(finance.outstandingPayments)}
                unit="BHD owed to you"
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* Revenue Streams */}
            <Card>
              <SectionLabel>REVENUE STREAMS</SectionLabel>
              <TableRow
                label="Product Sales (Net)"
                value={`${fmt(finance.netRevenue)} BHD`}
                color="#0F0F10"
              />
              <TableRow
                label="Repair Revenue"
                value={`${fmt(finance.repairRevenue)} BHD`}
                color="#0F0F10"
              />
              <TableRow
                label="Scrap Gold Spread"
                value={`${fmt(finance.scrapSpread)} BHD`}
                /* L-15 — Spread (Profit), nie voller Sale-Price; eigener Stream
                   (Entscheid A). Rot bei Verlust-Trades, sonst gruen. */
                color={finance.scrapSpread < 0 ? '#AA6E6E' : '#7EAA6E'}
              />
              <TableRow
                label="Consignment Commissions"
                value={`${fmt(finance.consignmentComm)} BHD`}
                /* v0.7.22 — bei cost_split-Shortfall ist die Marge negativ (Verlust);
                   dann rot statt grün, sonst wirkt ein Verlust wie eine Einnahme. */
                color={finance.consignmentComm < 0 ? '#AA6E6E' : '#7EAA6E'}
              />
              <TableRow
                label="Approval Commissions (Paid Out)"
                value={`${fmt(finance.agentCommTotal)} BHD`}
                color="#AA6E6E"
              />
              <TableRow
                label="VAT Collected"
                value={`${fmt(finance.totalVat)} BHD`}
                color="#4B5563"
                borderBottom={false}
              />
            </Card>

            {/* ═══ CASHFLOW ═══ */}
            <div style={{ marginTop: 32 }}>
              <h2 className="font-display" style={{ fontSize: 20, color: '#0F0F10', marginBottom: 16 }}>Cashflow</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 20 }}>
                <KPICard
                  label="CASH BALANCE"
                  value={fmtDec(finance.cashBalance, 2)}
                  unit="BHD on hand"
                  icon={<Wallet size={16} />}
                />
                <KPICard
                  label="BANK BALANCE"
                  value={fmtDec(finance.bankBalance, 2)}
                  unit="BHD (incl. cards net of fees)"
                  icon={<Building2 size={16} />}
                />
                <KPICard
                  label="BENEFIT BALANCE"
                  value={fmtDec(finance.benefitBalance, 2)}
                  unit="BHD (BenefitPay)"
                  icon={<Smartphone size={16} />}
                />
                <KPICard
                  label="TOTAL LIQUID"
                  value={fmtDec(finance.totalLiquid, 2)}
                  unit="BHD available"
                  icon={<DollarSign size={16} />}
                />
              </div>

              <Card>
                <SectionLabel>CASH &amp; BANK BREAKDOWN</SectionLabel>
                {(finance.openingCash > 0 || finance.openingBank > 0) && (
                  <TableRow label="Opening balance (cash + bank)" value={`${fmtDec(finance.openingCash + finance.openingBank, 2)} BHD`} color="#4B5563" />
                )}
                <TableRow label="Cash received (invoices)" value={`${fmtDec(finance.cashReceived, 2)} BHD`} color="#0F0F10" />
                <TableRow label="Bank transfers received" value={`${fmtDec(finance.bankReceived, 2)} BHD`} color="#0F0F10" />
                <TableRow label="Card payments received (gross)" value={`${fmtDec(finance.cardReceived, 2)} BHD`} color="#4B5563" />
                <TableRow label={`Card processing fees (${fmtDec(finance.cardFeeRate, 2)}%)`} value={`- ${fmtDec(finance.cardFeeLost, 2)} BHD`} color="#AA6E6E" />
                <TableRow label="Card → Bank (net)" value={`${fmtDec(finance.cardNetToBank, 2)} BHD`} color="#7EAA6E" />
                {finance.benefitReceived > 0 && <TableRow label="Benefit received" value={`${fmtDec(finance.benefitReceived, 2)} BHD`} color="#4B5563" />}
                {(finance.productEkCash + finance.productEkBank) > 0 && <TableRow label="Product purchases (EK paid out, manual)" value={`- ${fmtDec(finance.productEkCash + finance.productEkBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.purchasePaidCash + finance.purchasePaidBank) > 0 && <TableRow label="Supplier payments (Purchases module)" value={`- ${fmtDec(finance.purchasePaidCash + finance.purchasePaidBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.expenseCash + finance.expenseBank) > 0 && <TableRow label="Operating expenses" value={`- ${fmtDec(finance.expenseCash + finance.expenseBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.purchaseRefundCash + finance.purchaseRefundBank) > 0 && <TableRow label="Supplier refunds (Purchase returns)" value={`+ ${fmtDec(finance.purchaseRefundCash + finance.purchaseRefundBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.salesRefundCash + finance.salesRefundBank) > 0 && <TableRow label="Customer refunds (Sales returns)" value={`- ${fmtDec(finance.salesRefundCash + finance.salesRefundBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.partnerInvestCash + finance.partnerInvestBank) > 0 && <TableRow label="Partner investments (in)" value={`+ ${fmtDec(finance.partnerInvestCash + finance.partnerInvestBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.partnerWithdrawCash + finance.partnerWithdrawBank) > 0 && <TableRow label="Partner withdrawals / profit share (out)" value={`- ${fmtDec(finance.partnerWithdrawCash + finance.partnerWithdrawBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.cashToBank + finance.bankToCash + finance.cashToBenefit + finance.benefitToCash + finance.bankToBenefit + finance.benefitToBank) > 0 && <TableRow label="Internal Cash ↔ Bank ↔ Benefit transfers" value={`${fmtDec(finance.cashToBank + finance.bankToCash + finance.cashToBenefit + finance.benefitToCash + finance.bankToBenefit + finance.benefitToBank, 2)} BHD (neutral)`} color="#6B7280" />}
                {(finance.repairCashIn + finance.repairBankIn) > 0 && <TableRow label="Repair charges received" value={`+ ${fmtDec(finance.repairCashIn + finance.repairBankIn, 2)} BHD`} color="#7EAA6E" />}
                {(finance.repairCashOut + finance.repairBankOut) > 0 && <TableRow label="Repair internal costs paid" value={`- ${fmtDec(finance.repairCashOut + finance.repairBankOut, 2)} BHD`} color="#AA6E6E" />}
                {(finance.consignSaleCash + finance.consignSaleBank) > 0 && <TableRow label="Consignment sales received" value={`+ ${fmtDec(finance.consignSaleCash + finance.consignSaleBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.consignPayoutCash + finance.consignPayoutBank) > 0 && <TableRow label="Consignment payouts to consignors" value={`- ${fmtDec(finance.consignPayoutCash + finance.consignPayoutBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.agentSettleCash + finance.agentSettleBank) > 0 && <TableRow label="Agent settlements received" value={`+ ${fmtDec(finance.agentSettleCash + finance.agentSettleBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.orderDepositCash + finance.orderDepositBank) > 0 && <TableRow label="Order deposits (pre-invoice)" value={`+ ${fmtDec(finance.orderDepositCash + finance.orderDepositBank, 2)} BHD`} color="#7EAA6E" />}
                {finance.taxPaidTotal > 0 && <TableRow label="Quarterly tax paid (outflow)" value={`- ${fmtDec(finance.taxPaidTotal, 2)} BHD`} color="#AA6E6E" />}
                {(finance.lentOutCash + finance.lentOutBank) > 0 && <TableRow label="Lent out (debts to us)" value={`- ${fmtDec(finance.lentOutCash + finance.lentOutBank, 2)} BHD`} color="#AA956E" />}
                {(finance.debtRepaidToUsCash + finance.debtRepaidToUsBank) > 0 && <TableRow label="Debt repaid to us" value={`+ ${fmtDec(finance.debtRepaidToUsCash + finance.debtRepaidToUsBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.borrowedInCash + finance.borrowedInBank) > 0 && <TableRow label="Borrowed in" value={`+ ${fmtDec(finance.borrowedInCash + finance.borrowedInBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.debtRepaidByUsCash + finance.debtRepaidByUsBank) > 0 && <TableRow label="Repaid by us" value={`- ${fmtDec(finance.debtRepaidByUsCash + finance.debtRepaidByUsBank, 2)} BHD`} color="#AA6E6E" borderBottom={false} />}
              </Card>
            </div>

            {/* ═══ QUARTERLY TAX ═══ */}
            <div style={{ marginTop: 32 }}>
              <h2 className="font-display" style={{ fontSize: 20, color: '#0F0F10', marginBottom: 16 }}>Quarterly VAT</h2>
              <Card>
                <SectionLabel>VAT PER QUARTER — FROM NON-BUTTERFLY INVOICES</SectionLabel>
                {finance.quarterly.length === 0 && (
                  <p style={{ padding: 24, textAlign: 'center', fontSize: 13, color: '#6B7280' }}>No VAT-relevant invoices yet.</p>
                )}
                {finance.quarterly.map(q => {
                  // Plan §Purchase §Tax + §Erstattung: Net-VAT = Schuld an NBR,
                  // Refund = Erstattung von NBR. Visuell unterscheiden.
                  const isRefund = q.refund > 0.005;
                  const remaining = q.netVat - q.paid;
                  const isSettled = !isRefund && remaining <= 0.01;
                  return (
                    <div key={`${q.year}-${q.quarter}`}
                      className="flex items-center justify-between"
                      style={{ padding: '14px 0', borderBottom: '1px solid #E5E9EE', gap: 16 }}>
                      <div className="flex items-center gap-3" style={{ flex: 1 }}>
                        {isRefund ? <CheckCircle2 size={16} style={{ color: '#3D7FFF' }} />
                          : isSettled ? <CheckCircle2 size={16} style={{ color: '#7EAA6E' }} />
                          : <Clock size={16} style={{ color: '#AA956E' }} />}
                        <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{q.year} · Q{q.quarter}</span>
                        {isRefund && (
                          <span style={{ fontSize: 10, color: '#3D7FFF', padding: '2px 8px', borderRadius: 999, background: 'rgba(61,127,255,0.10)', border: '1px solid rgba(61,127,255,0.3)' }}>
                            Refund Due
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>OUTPUT VAT</span>
                          <span className="font-mono" style={{ fontSize: 14, color: '#4B5563' }}>{fmtDec(q.vat, 2)}</span>
                        </div>
                        <div className="text-right">
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>INPUT VAT</span>
                          <span className="font-mono" style={{ fontSize: 14, color: q.inputVat > 0 ? '#7EAA6E' : '#6B7280' }}>− {fmtDec(q.inputVat, 2)}</span>
                        </div>
                        <div className="text-right">
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>{isRefund ? 'REFUND' : 'NET OWED'}</span>
                          <span className="font-mono" style={{ fontSize: 14, color: isRefund ? '#3D7FFF' : '#0F0F10', fontWeight: 600 }}>
                            {fmtDec(isRefund ? q.refund : q.netVat, 2)}
                          </span>
                        </div>
                        <div className="text-right">
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>PAID</span>
                          <span className="font-mono" style={{ fontSize: 14, color: q.paid > 0 ? '#7EAA6E' : '#6B7280' }}>{fmtDec(q.paid, 2)}</span>
                        </div>
                        <div className="text-right" style={{ minWidth: 90 }}>
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>REMAINING</span>
                          <span className="font-mono" style={{ fontSize: 14, color: isRefund ? '#3D7FFF' : isSettled ? '#7EAA6E' : '#AA6E6E' }}>
                            {isRefund ? '—' : fmtDec(Math.max(0, remaining), 2)}
                          </span>
                        </div>
                        {/* Das Eintragen einer Steuerzahlung ist ein SCHREIBvorgang und gehört
                            nicht zu den geprüften Fernbuchungen. Statt eine Schaltfläche
                            anzubieten, die auf einem Rechner ohne Datenbank nichts täte, gibt
                            es sie dort nicht — gelesen wird die Auswertung trotzdem vollständig. */}
                        {!isSettled && !isRefund && !readsFromPrimary() && (
                          <button
                            onClick={() => setTaxPayQuarter({ year: q.year, quarter: q.quarter, vat: q.netVat, paid: q.paid })}
                            className="cursor-pointer"
                            style={{ padding: '6px 14px', fontSize: 11, background: 'rgba(15,15,16,0.08)', border: '1px solid rgba(198,163,109,0.3)', borderRadius: 6, color: '#0F0F10' }}
                          >Mark paid</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </Card>
            </div>

            {/* VAT Export */}
            <div style={{ marginTop: 20 }}>
              <button
                onClick={async () => {
                  // Die Zeilen kommen aus derselben Quelle wie die Zahlen oben: am Primary aus
                  // der eigenen Datenbank, sonst als eine Auskunft vom Primary.
                  const { invoices: rows, lines: rawLines } = await vatExportRows();
                  const header = 'Invoice,Date,Customer,Status,Tax Scheme,Net Amount,VAT Amount,Gross Amount,Purchase Price,Sale Price,Margin';
                  const csvRows = rows.map(r => [
                    r.invoice_number, (r.created_at as string).split('T')[0],
                    (r.customer_name as string || '').replace(/,/g, ' '), r.status, r.tax_scheme_snapshot,
                    (r.net_amount as number).toFixed(3), (r.vat_amount as number).toFixed(3),
                    (r.gross_amount as number).toFixed(3),
                    ((r.purchase_price_snapshot as number) || 0).toFixed(3),
                    ((r.sale_price_snapshot as number) || 0).toFixed(3),
                    ((r.margin_snapshot as number) || 0).toFixed(3),
                  ].join(','));

                  // Line-level detail
                  const lineHeader = '\n\nInvoice,Product,Tax Scheme,Unit Price,Purchase Price,Margin,VAT Rate,VAT Amount,Line Total';
                  const lineRows = rawLines.map(r => {
                    const margin = (r.tax_scheme as string) === 'MARGIN' ? (r.unit_price as number) - ((r.purchase_price_snapshot as number) || 0) : 0;
                    return [
                      r.invoice_number, (r.product_name as string).replace(/,/g, ' '),
                      r.tax_scheme, (r.unit_price as number).toFixed(3),
                      ((r.purchase_price_snapshot as number) || 0).toFixed(3),
                      margin.toFixed(3), r.vat_rate, (r.vat_amount as number).toFixed(3),
                      (r.line_total as number).toFixed(3),
                    ].join(',');
                  });

                  const csv = [header, ...csvRows, lineHeader, ...lineRows].join('\n');
                  exportCsv(`LATAIF_VAT_Report_${new Date().toISOString().split('T')[0]}.csv`, csv);
                }}
                className="cursor-pointer flex items-center gap-2 transition-colors"
                style={{ padding: '12px 20px', fontSize: 13, background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 8, color: '#4B5563' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#0F0F10'; e.currentTarget.style.color = '#0F0F10'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#E5E9EE'; e.currentTarget.style.color = '#4B5563'; }}
              >
                <FileText size={14} />
                Export VAT Report (CSV) — All Invoices with Line Details
              </button>
            </div>
          </div>
        )}

        {/* ════════════════ CLIENT DASHBOARD ════════════════ */}
        {activeTab === 'clients' && clients && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="TOTAL CLIENTS"
                value={clients.totalClients}
                icon={<Users size={16} />}
              />
              <KPICard
                label="ACTIVE CLIENTS"
                value={clients.activeClients}
                unit="purchased in last 180 days"
                icon={<Users size={16} />}
              />
              <KPICard
                label="DORMANT CLIENTS"
                value={clients.dormantClients}
                icon={<Users size={16} />}
              />
              <KPICard
                label="AVG CLIENT VALUE"
                value={fmt(clients.avgClientValue)}
                unit="BHD"
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* Second Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="REPEAT PURCHASE RATE"
                value={pct(clients.repeatRate)}
                unit={`${clients.repeatCount} of ${clients.buyingCount} buying clients`}
                icon={<TrendingUp size={16} />}
              />
              <Card>
                <SectionLabel>VIP DISTRIBUTION</SectionLabel>
                {clients.vipDist.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '12px 0' }}>No clients.</p>
                )}
                {clients.vipDist.map((v, i) => {
                  const level = num(v, 'vip_level');
                  const count = num(v, 'cnt');
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between"
                      style={{
                        padding: '10px 0',
                        borderBottom: i < clients.vipDist.length - 1 ? '1px solid #E5E9EE' : 'none',
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="rounded-full"
                          style={{
                            width: 8,
                            height: 8,
                            background: vipColors[level] || '#6B7280',
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: 14, color: vipColors[level] || '#0F0F10' }}>
                          {vipLabels[level] || `Level ${level}`}
                        </span>
                      </div>
                      <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{count}</span>
                    </div>
                  );
                })}
              </Card>
            </div>

            {/* Top Clients */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Card>
                <SectionLabel>TOP 5 CLIENTS BY REVENUE</SectionLabel>
                {clients.topByRev.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No client data yet.</p>
                )}
                {clients.topByRev.map((c, i) => (
                  <RankedItem
                    key={c.id}
                    rank={i + 1}
                    label={c.name}
                    value={`${fmt(c.gross)} BHD`}
                    sub={`${c.count} purchases`}
                  />
                ))}
              </Card>

              <Card>
                <SectionLabel>TOP 5 CLIENTS BY PROFIT</SectionLabel>
                {clients.topByProfit.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No client data yet.</p>
                )}
                {clients.topByProfit.map((c, i) => (
                  <RankedItem
                    key={c.id}
                    rank={i + 1}
                    label={c.name}
                    value={`${fmt(c.profit)} BHD`}
                    sub={`${c.count} purchases`}
                    color="#7EAA6E"
                  />
                ))}
              </Card>
            </div>
          </div>
        )}
      </main>

      {/* ── Tax Payment Modal ── */}
      <Modal open={!!taxPayQuarter} onClose={() => setTaxPayQuarter(null)} title={taxPayQuarter ? `Record VAT Payment — ${taxPayQuarter.year} Q${taxPayQuarter.quarter}` : ''} width={460}>
        {taxPayQuarter && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ padding: '12px 14px', background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>VAT owed</span>
                <span className="font-mono" style={{ color: '#4B5563' }}>{fmtDec(taxPayQuarter.vat, 2)} BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>Already paid</span>
                <span className="font-mono" style={{ color: '#7EAA6E' }}>{fmtDec(taxPayQuarter.paid, 2)} BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 13, paddingTop: 6, borderTop: '1px solid #E5E9EE', marginTop: 6 }}>
                <span style={{ color: '#0F0F10' }}>Remaining</span>
                <span className="font-mono" style={{ color: '#AA6E6E' }}>{fmtDec(Math.max(0, taxPayQuarter.vat - taxPayQuarter.paid), 2)} BHD</span>
              </div>
            </div>
            <Input label="AMOUNT (BHD)" type="number" step="0.001" value={taxPayAmount} onChange={e => setTaxPayAmount(e.target.value)} />
            <Input label="PAID ON" type="date" value={taxPayDate} onChange={e => setTaxPayDate(e.target.value)} />
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>PAID FROM</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {(['bank', 'cash'] as const).map(s => (
                  <button key={s} onClick={() => setTaxPaySource(s)}
                    className="cursor-pointer rounded" style={{
                      padding: '6px 16px', fontSize: 12,
                      border: `1px solid ${taxPaySource === s ? '#0F0F10' : '#D5D9DE'}`,
                      color: taxPaySource === s ? '#0F0F10' : '#6B7280',
                      background: taxPaySource === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{s === 'bank' ? 'Bank' : 'Cash'}</button>
                ))}
              </div>
            </div>
            <Input label="REFERENCE / NOTE (optional)" value={taxPayNote} onChange={e => setTaxPayNote(e.target.value)} placeholder="NBR confirmation #, etc." />
            <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => setTaxPayQuarter(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirmTaxPayment}>Record Payment</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
