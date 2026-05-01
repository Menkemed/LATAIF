import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Calendar, Clock, Download, ExternalLink, FileText, X } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Card } from '@/components/ui/Card';
import {
  usePayablesStore, payablesTotal, overdueCount, bucketTotals,
  PAYABLE_TYPE_LABELS, PAYABLE_TYPE_COLORS,
  type PayableType, type AgeBucket, type PayableRow,
} from '@/stores/payablesStore';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const ALL_TYPES: PayableType[] = ['refund', 'supplier', 'agent', 'consignor', 'expense', 'loan'];

const BUCKET_META: Record<AgeBucket, { label: string; fg: string; bg: string; ring: string }> = {
  'current': { label: 'Current',         fg: '#16A34A', bg: 'rgba(22,163,74,0.08)',  ring: 'rgba(22,163,74,0.18)' },
  '1-30':    { label: '1–30 days',       fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', ring: 'rgba(255,135,48,0.22)' },
  '31-60':   { label: '31–60 days',      fg: '#DC2626', bg: 'rgba(220,38,38,0.08)',  ring: 'rgba(220,38,38,0.20)' },
  '60+':     { label: '60+ days',        fg: '#7F1D1D', bg: 'rgba(127,29,29,0.10)',  ring: 'rgba(127,29,29,0.30)' },
};

function ageLabel(daysOverdue: number): { text: string; color: string } {
  if (daysOverdue > 0) return { text: `${daysOverdue} days overdue`, color: daysOverdue > 60 ? '#7F1D1D' : daysOverdue > 30 ? '#DC2626' : '#FF8730' };
  if (daysOverdue === 0) return { text: 'Due today', color: '#FF8730' };
  return { text: `in ${Math.abs(daysOverdue)} days`, color: '#6B7280' };
}

function downloadCsv(rows: PayableRow[]) {
  const header = ['Type', 'Reference', 'Counterparty', 'Issued', 'Due', 'Days Overdue', 'Amount (BHD)', 'Paid (BHD)', 'Outstanding (BHD)'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells = [
      PAYABLE_TYPE_LABELS[r.type],
      r.referenceNumber,
      `"${r.counterpartyName.replace(/"/g, '""')}"`,
      r.issuedAt.split('T')[0] || r.issuedAt,
      r.dueAt ? r.dueAt.split('T')[0] : '',
      String(r.daysOverdue),
      r.totalAmount.toFixed(3),
      r.paidAmount.toFixed(3),
      r.outstanding.toFixed(3),
    ];
    lines.push(cells.join(','));
  }
  const csv = lines.join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `payables-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function PayablesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { payables, loadPayables } = usePayablesStore();

  const initialTypeParam = searchParams.get('type');
  const initialOverdue = searchParams.get('overdue') === '1';

  const [search, setSearch] = useState('');
  const [activeTypes, setActiveTypes] = useState<PayableType[]>(
    initialTypeParam && ALL_TYPES.includes(initialTypeParam as PayableType)
      ? [initialTypeParam as PayableType]
      : []
  );
  const [overdueOnly, setOverdueOnly] = useState(initialOverdue);

  useEffect(() => { loadPayables(); }, [loadPayables]);

  // URL-Sync (typ/overdue) damit Dashboard-Klicks deep-linken können.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (activeTypes.length === 1) next.set('type', activeTypes[0]); else next.delete('type');
    if (overdueOnly) next.set('overdue', '1'); else next.delete('overdue');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTypes, overdueOnly]);

  const filtered = useMemo(() => {
    let r = payables;
    if (activeTypes.length > 0) r = r.filter(x => activeTypes.includes(x.type));
    if (overdueOnly) r = r.filter(x => x.daysOverdue > 0);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(x =>
        x.counterpartyName.toLowerCase().includes(q) ||
        x.referenceNumber.toLowerCase().includes(q) ||
        x.detailLabel.toLowerCase().includes(q)
      );
    }
    return r;
  }, [payables, activeTypes, overdueOnly, search]);

  const total = payablesTotal(payables);
  const overdueN = overdueCount(payables);
  const buckets = bucketTotals(payables);

  function toggleType(t: PayableType) {
    setActiveTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  }

  return (
    <PageLayout
      title="Payables"
      subtitle={`${payables.length} open · ${overdueN} overdue · ${fmt(total)} BHD total`}
      showSearch onSearch={setSearch} searchPlaceholder="Search reference or counterparty..."
      actions={
        <button
          onClick={() => downloadCsv(filtered)}
          className="flex items-center gap-2 cursor-pointer transition-colors"
          style={{
            padding: '8px 14px', fontSize: 13, color: '#4B5563',
            background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 8,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#F2F7FA')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <Download size={14} /> Export CSV
        </button>
      }
    >
      {/* ── Aging buckets ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {(['current', '1-30', '31-60', '60+'] as AgeBucket[]).map(b => {
          const meta = BUCKET_META[b];
          const data = buckets[b];
          return (
            <Card key={b}>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: meta.fg, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{meta.label}</span>
                <div style={{
                  width: 30, height: 30, borderRadius: 8, background: meta.bg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: meta.fg,
                }}>
                  {b === 'current' ? <Clock size={14} /> : <AlertTriangle size={14} />}
                </div>
              </div>
              <div className="font-display" style={{ fontSize: 24, color: '#0F0F10', lineHeight: 1.1 }}>
                {fmt(data.total)} <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
              </div>
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                {data.count} {data.count === 1 ? 'item' : 'items'}
              </div>
            </Card>
          );
        })}
      </div>

      {/* ── Filter bar ── */}
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 4 }}>Filter</span>
        {ALL_TYPES.map(t => {
          const colors = PAYABLE_TYPE_COLORS[t];
          const active = activeTypes.includes(t);
          return (
            <button
              key={t}
              onClick={() => toggleType(t)}
              className="cursor-pointer transition-all duration-150"
              style={{
                padding: '5px 12px', fontSize: 12, borderRadius: 999, fontWeight: 500,
                color: active ? colors.fg : '#6B7280',
                background: active ? colors.bg : 'transparent',
                border: `1px solid ${active ? colors.fg + '40' : '#D5D9DE'}`,
              }}
            >
              {PAYABLE_TYPE_LABELS[t]}
            </button>
          );
        })}
        <button
          onClick={() => setOverdueOnly(v => !v)}
          className="cursor-pointer transition-all duration-150"
          style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 999, fontWeight: 500,
            color: overdueOnly ? '#DC2626' : '#6B7280',
            background: overdueOnly ? 'rgba(220,38,38,0.08)' : 'transparent',
            border: `1px solid ${overdueOnly ? 'rgba(220,38,38,0.40)' : '#D5D9DE'}`,
            marginLeft: 4,
          }}
        >
          {overdueOnly ? '✓ ' : ''}Overdue only
        </button>
        {(activeTypes.length > 0 || overdueOnly || search) && (
          <button
            onClick={() => { setActiveTypes([]); setOverdueOnly(false); setSearch(''); }}
            className="cursor-pointer flex items-center gap-1"
            style={{
              padding: '5px 10px', fontSize: 11, color: '#6B7280', background: 'transparent',
              border: 'none', marginLeft: 'auto',
            }}
          >
            <X size={12} /> Reset
          </button>
        )}
      </div>

      {/* ── Table header ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr)',
        gap: 16,
        padding: '0 16px 12px',
      }}>
        <span className="text-overline">DUE / AGE</span>
        <span className="text-overline">TYPE</span>
        <span className="text-overline">REFERENCE</span>
        <span className="text-overline">COUNTERPARTY</span>
        <span className="text-overline">ISSUED</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>AMOUNT</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>OUTSTANDING</span>
      </div>
      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
          {payables.length === 0
            ? 'No open payables. Everything is settled.'
            : 'No payables match your filter.'}
        </div>
      )}

      {filtered.map(row => {
        const colors = PAYABLE_TYPE_COLORS[row.type];
        const age = ageLabel(row.daysOverdue);
        return (
          <div
            key={row.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr)',
              gap: 16,
              padding: '14px 16px',
              alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => row.navigateTo && navigate(row.navigateTo)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {/* DUE / AGE */}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: age.color, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {age.text}
              </div>
              <div className="flex items-center gap-1" style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>
                <Calendar size={10} /> {row.dueAt ? fmtDate(row.dueAt) : `${fmtDate(row.issuedAt)} + grace`}
              </div>
            </div>

            {/* TYPE */}
            <div style={{ minWidth: 0 }}>
              <span style={{
                padding: '3px 10px', fontSize: 11, borderRadius: 999, fontWeight: 500,
                color: colors.fg, background: colors.bg, border: `1px solid ${colors.fg}30`,
                whiteSpace: 'nowrap',
              }}>
                {PAYABLE_TYPE_LABELS[row.type]}
              </span>
              <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.detailLabel}
              </div>
            </div>

            {/* REFERENCE */}
            <div style={{ minWidth: 0 }}>
              <span
                onClick={(e) => { e.stopPropagation(); row.navigateTo && navigate(row.navigateTo); }}
                className="font-mono cursor-pointer"
                style={{
                  fontSize: 13, color: '#3D7FFF', textDecoration: 'underline',
                  textUnderlineOffset: 3, textDecorationColor: 'rgba(61,127,255,0.30)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                {row.referenceNumber}
                <ExternalLink size={11} style={{ opacity: 0.6 }} />
              </span>
            </div>

            {/* COUNTERPARTY */}
            <div style={{ minWidth: 0 }}>
              {row.counterpartyHref ? (
                <span
                  onClick={(e) => { e.stopPropagation(); navigate(row.counterpartyHref!); }}
                  className="cursor-pointer"
                  style={{
                    fontSize: 14, color: '#0F0F10',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    display: 'block',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#3D7FFF'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = '#0F0F10'; }}
                >
                  {row.counterpartyName}
                </span>
              ) : (
                <span style={{ fontSize: 14, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                  {row.counterpartyName}
                </span>
              )}
            </div>

            {/* ISSUED */}
            <div style={{ fontSize: 12, color: '#4B5563', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtDate(row.issuedAt)}
            </div>

            {/* AMOUNT (gross original) */}
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 13, color: '#6B7280', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(row.totalAmount)}</div>
              {row.paidAmount > 0 && (
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>
                  paid {fmt(row.paidAmount)}
                </div>
              )}
            </div>

            {/* OUTSTANDING */}
            <div className="font-mono" style={{
              textAlign: 'right', fontSize: 14, fontWeight: 600,
              color: row.daysOverdue > 0 ? '#DC2626' : '#0F0F10',
              minWidth: 0, overflow: 'hidden',
            }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmt(row.outstanding)}</div>
              <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 400, marginTop: 2 }}>BHD</div>
            </div>
          </div>
        );
      })}

      {/* ── Footer total ── */}
      {filtered.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr)',
          gap: 16,
          padding: '20px 16px 8px',
          borderTop: '2px solid #E5E9EE',
          marginTop: 8,
        }}>
          <div style={{ gridColumn: 'span 5', fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={14} />
            Showing {filtered.length} of {payables.length} payables
          </div>
          <div className="font-mono" style={{ textAlign: 'right', fontSize: 13, color: '#6B7280' }}>
            {fmt(filtered.reduce((s, r) => s + r.totalAmount, 0))}
          </div>
          <div className="font-mono" style={{ textAlign: 'right', fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>
            {fmt(filtered.reduce((s, r) => s + r.outstanding, 0))} <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>BHD</span>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
