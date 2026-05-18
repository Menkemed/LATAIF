// Plan §Scrap Gold Quick Trade — List-View mit KPIs, Filter und Tabelle.
// Profit-Spalte ist visuell hervorgehoben (grün/rot) — nur dieser Spread
// landet im Ledger als REVENUE, nicht der Sale Price.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Coins, Plus, TrendingUp, TrendingDown } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { useScrapTradeStore } from '@/stores/scrapTradeStore';
import type { ScrapTrade, ScrapTradeStatus } from '@/core/models/types';

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

const STATUS_STYLE: Record<ScrapTradeStatus, { label: string; fg: string; bg: string }> = {
  completed: { label: 'Completed', fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
  cancelled: { label: 'Cancelled', fg: '#DC2626', bg: 'rgba(220,38,38,0.10)' },
};

const STATUS_FILTERS: { value: ScrapTradeStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const GRID = 'minmax(0,0.9fr) minmax(0,1fr) minmax(0,1.3fr) minmax(0,1.3fr) minmax(0,0.8fr) minmax(0,0.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.9fr)';

export function ScrapTradeList() {
  const navigate = useNavigate();
  const { trades, loadTrades } = useScrapTradeStore();
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<ScrapTradeStatus | ''>('');

  useEffect(() => { loadTrades(); }, [loadTrades]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return trades.filter(t => {
      if (filterStatus && t.status !== filterStatus) return false;
      if (q) {
        const hay = `${t.tradeNumber} ${t.sellerName} ${t.buyerName} ${t.karat} ${t.notes || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [trades, search, filterStatus]);

  const stats = useMemo(() => {
    const active = trades.filter(t => t.status === 'completed');
    const totalProfit = active.reduce((s, t) => s + t.profit, 0);
    const totalWeight = active.reduce((s, t) => s + t.weightGrams, 0);
    const avg = active.length > 0 ? totalProfit / active.length : 0;
    return { count: active.length, totalProfit, totalWeight, avg };
  }, [trades]);

  return (
    <PageLayout
      title="Scrap Gold"
      subtitle="Quick Trade — Altgold ankaufen und sofort weiterverkaufen"
      actions={
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => navigate('/scrap-trades/new')}>
          New Trade
        </Button>
      }
    >
      <div style={{ maxWidth: 1500, margin: '0 auto' }}>
        {/* KPI Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
          <Card>
            <div className="text-overline" style={{ marginBottom: 8 }}>Total Trades</div>
            <div style={{ fontSize: 28, fontWeight: 600 }}>{stats.count}</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
              {stats.totalWeight.toFixed(1)} g total weight
            </div>
          </Card>
          <Card>
            <div className="text-overline" style={{ marginBottom: 8 }}>Total Profit</div>
            <div style={{ fontSize: 28, fontWeight: 600, color: stats.totalProfit >= 0 ? '#16A34A' : '#DC2626' }}>
              <Bhd v={stats.totalProfit} />
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>BHD</div>
          </Card>
          <Card>
            <div className="text-overline" style={{ marginBottom: 8 }}>Avg Profit / Trade</div>
            <div style={{ fontSize: 28, fontWeight: 600 }}>
              <Bhd v={stats.avg} />
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>BHD</div>
          </Card>
        </div>

        {/* Filter Bar */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Search by seller, buyer, trade #, karat..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                flex: 1, minWidth: 240,
                background: '#F2F7FA', border: '1px solid #E5E9EE',
                borderRadius: 8, padding: '10px 14px', fontSize: 13,
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {STATUS_FILTERS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setFilterStatus(opt.value)}
                  style={{
                    padding: '8px 14px', fontSize: 12, borderRadius: 999,
                    border: '1px solid ' + (filterStatus === opt.value ? '#0F0F10' : '#E5E9EE'),
                    background: filterStatus === opt.value ? '#0F0F10' : 'transparent',
                    color: filterStatus === opt.value ? '#FFFFFF' : '#6B7280',
                    cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/* Table */}
        <Card noPadding>
          {/* Header */}
          <div
            style={{
              display: 'grid', gridTemplateColumns: GRID, gap: 12,
              padding: '14px 22px',
              borderBottom: '1px solid #E5E9EE',
              fontSize: 11, fontWeight: 600, color: '#6B7280',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}
          >
            <div>Date</div>
            <div>Trade #</div>
            <div>Seller</div>
            <div>Buyer</div>
            <div>Weight</div>
            <div>Karat</div>
            <div style={{ textAlign: 'right' }}>Purchase</div>
            <div style={{ textAlign: 'right' }}>Sale</div>
            <div style={{ textAlign: 'right' }}>Profit</div>
            <div style={{ textAlign: 'right' }}>Status</div>
          </div>

          {/* Rows */}
          {filtered.length === 0 ? (
            <div style={{ padding: '60px 22px', textAlign: 'center', color: '#6B7280' }}>
              <Coins size={32} strokeWidth={1} style={{ marginBottom: 12, opacity: 0.4 }} />
              <div style={{ fontSize: 14 }}>No trades yet</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Click "New Trade" to record a scrap gold transaction</div>
            </div>
          ) : (
            filtered.map(trade => <TradeRow key={trade.id} trade={trade} onClick={() => navigate(`/scrap-trades/${trade.id}`)} />)
          )}
        </Card>
      </div>
    </PageLayout>
  );
}

function TradeRow({ trade, onClick }: { trade: ScrapTrade; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const status = STATUS_STYLE[trade.status];
  const profitColor = trade.profit > 0 ? '#16A34A' : trade.profit < 0 ? '#DC2626' : '#6B7280';
  const ProfitIcon = trade.profit > 0 ? TrendingUp : trade.profit < 0 ? TrendingDown : null;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 12,
        padding: '14px 22px',
        borderBottom: '1px solid #F2F7FA',
        background: hovered ? '#F8FAFB' : 'transparent',
        cursor: 'pointer', fontSize: 13,
        alignItems: 'center',
        opacity: trade.status === 'cancelled' ? 0.55 : 1,
      }}
    >
      <div style={{ color: '#6B7280' }}>{fmtDate(trade.tradeDate)}</div>
      <div style={{ fontWeight: 500, fontFamily: 'monospace', fontSize: 12 }}>{trade.tradeNumber}</div>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.sellerName}</div>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.buyerName}</div>
      <div>
        {trade.weightGrams.toFixed(2)} g
        {trade.lines.length > 1 && (
          <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>{trade.lines.length} items</div>
        )}
      </div>
      <div style={{ color: trade.karat === 'mixed' ? '#6B7280' : '#0F0F10', fontStyle: trade.karat === 'mixed' ? 'italic' : 'normal' }}>
        {trade.karat}
      </div>
      <div style={{ textAlign: 'right', color: '#6B7280' }}><Bhd v={trade.purchasePrice} /></div>
      <div style={{ textAlign: 'right', color: '#6B7280' }}><Bhd v={trade.salePrice} /></div>
      <div style={{ textAlign: 'right', color: profitColor, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
        {ProfitIcon && <ProfitIcon size={13} />}
        <Bhd v={trade.profit} />
      </div>
      <div style={{ textAlign: 'right' }}>
        <span style={{
          display: 'inline-block', padding: '4px 10px', borderRadius: 999,
          fontSize: 11, fontWeight: 500,
          color: status.fg, background: status.bg,
        }}>
          {status.label}
        </span>
      </div>
    </div>
  );
}
