import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Calendar, Clock, Download, ExternalLink, FileText, X } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import {
  receivablesBreakdown, bucketTotals, overdueCount, receivablesTotal,
  RECEIVABLE_SOURCE_LABELS, RECEIVABLE_SOURCE_COLORS,
  type ReceivableSource, type ReceivableAgeBucket, type ReceivableRow,
} from '@/core/finance/receivables';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useAgentStore } from '@/stores/agentStore';
import { useRepairStore } from '@/stores/repairStore';
import { useDebtStore } from '@/stores/debtStore';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const ALL_SOURCES: ReceivableSource[] = ['INVOICE', 'CONSIGNMENT', 'APPROVAL', 'REPAIR'];

const BUCKET_META: Record<ReceivableAgeBucket, { label: string; fg: string; bg: string; ring: string }> = {
  'current': { label: 'Current',         fg: '#16A34A', bg: 'rgba(22,163,74,0.08)',  ring: 'rgba(22,163,74,0.18)' },
  '1-30':    { label: '1–30 days',       fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', ring: 'rgba(255,135,48,0.22)' },
  '31-60':   { label: '31–60 days',      fg: '#DC2626', bg: 'rgba(220,38,38,0.08)',  ring: 'rgba(220,38,38,0.20)' },
  '60+':     { label: '60+ days',        fg: '#7F1D1D', bg: 'rgba(127,29,29,0.10)',  ring: 'rgba(127,29,29,0.30)' },
};

function ageLabel(daysOverdue: number, hasDue: boolean): { text: string; color: string } {
  if (daysOverdue > 0) return { text: `${daysOverdue} days overdue`, color: daysOverdue > 60 ? '#7F1D1D' : daysOverdue > 30 ? '#DC2626' : '#FF8730' };
  if (daysOverdue === 0) return { text: hasDue ? 'Due today' : 'Today', color: '#FF8730' };
  return { text: hasDue ? `in ${Math.abs(daysOverdue)} days` : 'Open', color: '#6B7280' };
}

function downloadCsv(rows: ReceivableRow[]) {
  const header = ['Source', 'Reference', 'Client', 'Issued', 'Due', 'Days Overdue', 'Amount (BHD)', 'Paid (BHD)', 'Outstanding (BHD)'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells = [
      RECEIVABLE_SOURCE_LABELS[r.source],
      r.reference,
      `"${r.customerName.replace(/"/g, '""')}"`,
      r.issuedAt.split('T')[0] || r.issuedAt,
      r.dueAt ? r.dueAt.split('T')[0] : '',
      String(r.daysOverdue),
      r.totalAmount.toFixed(3),
      r.paidAmount.toFixed(3),
      r.open.toFixed(3),
    ];
    lines.push(cells.join(','));
  }
  const csv = lines.join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receivables-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReceivablesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { consignments, loadConsignments } = useConsignmentStore();
  const { transfers, loadTransfers } = useAgentStore();
  const { repairs, loadRepairs } = useRepairStore();
  const { debts, loadDebts } = useDebtStore();

  const initialSourceParam = searchParams.get('source') || searchParams.get('type');
  const initialOverdue = searchParams.get('overdue') === '1';

  const [search, setSearch] = useState('');
  const [activeSources, setActiveSources] = useState<ReceivableSource[]>(
    initialSourceParam && ALL_SOURCES.includes(initialSourceParam.toUpperCase() as ReceivableSource)
      ? [initialSourceParam.toUpperCase() as ReceivableSource]
      : []
  );
  const [overdueOnly, setOverdueOnly] = useState(initialOverdue);

  useEffect(() => {
    loadInvoices(); loadConsignments(); loadTransfers(); loadRepairs(); loadDebts();
  }, [loadInvoices, loadConsignments, loadTransfers, loadRepairs, loadDebts]);

  // URL-Sync (source/overdue) — Dashboard-Klicks können deep-linken.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (activeSources.length === 1) next.set('source', activeSources[0]); else next.delete('source');
    if (overdueOnly) next.set('overdue', '1'); else next.delete('overdue');
    next.delete('type');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSources, overdueOnly]);

  const allRows = useMemo(
    () => receivablesBreakdown(),
    [invoices, consignments, transfers, repairs, debts]
  );

  const filtered = useMemo(() => {
    let r = allRows;
    if (activeSources.length > 0) r = r.filter(x => activeSources.includes(x.source));
    if (overdueOnly) r = r.filter(x => x.daysOverdue > 0);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(x =>
        x.customerName.toLowerCase().includes(q) ||
        x.reference.toLowerCase().includes(q) ||
        x.detailLabel.toLowerCase().includes(q)
      );
    }
    return r;
  }, [allRows, activeSources, overdueOnly, search]);

  const total = receivablesTotal(allRows);
  const overdueN = overdueCount(allRows);
  const buckets = bucketTotals(allRows);

  function toggleSource(s: ReceivableSource) {
    setActiveSources(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  return (
    <PageLayout
      title="Receivables"
      subtitle={`${allRows.length} open · ${overdueN} overdue · ${fmt(total)} BHD total`}
      showSearch onSearch={setSearch} searchPlaceholder="Search reference or client..."
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
        {(['current', '1-30', '31-60', '60+'] as ReceivableAgeBucket[]).map(b => {
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
                <Bhd v={data.total}/> <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
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
        {ALL_SOURCES.map(s => {
          const colors = RECEIVABLE_SOURCE_COLORS[s];
          const active = activeSources.includes(s);
          return (
            <button
              key={s}
              onClick={() => toggleSource(s)}
              className="cursor-pointer transition-all duration-150"
              style={{
                padding: '5px 12px', fontSize: 12, borderRadius: 999, fontWeight: 500,
                color: active ? colors.fg : '#6B7280',
                background: active ? colors.bg : 'transparent',
                border: `1px solid ${active ? colors.fg + '40' : '#D5D9DE'}`,
              }}
            >
              {RECEIVABLE_SOURCE_LABELS[s]}
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
        {(activeSources.length > 0 || overdueOnly || search) && (
          <button
            onClick={() => { setActiveSources([]); setOverdueOnly(false); setSearch(''); }}
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
        <span className="text-overline">SOURCE</span>
        <span className="text-overline">REFERENCE</span>
        <span className="text-overline">CLIENT</span>
        <span className="text-overline">ISSUED</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>AMOUNT</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>OUTSTANDING</span>
      </div>
      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
          {allRows.length === 0
            ? 'No open receivables. Everything is collected.'
            : 'No receivables match your filter.'}
        </div>
      )}

      {filtered.map(row => {
        const colors = RECEIVABLE_SOURCE_COLORS[row.source];
        const age = ageLabel(row.daysOverdue, !!row.dueAt);
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
                <Calendar size={10} /> {row.dueAt ? fmtDate(row.dueAt) : '—'}
              </div>
            </div>

            {/* SOURCE */}
            <div style={{ minWidth: 0 }}>
              <span style={{
                padding: '3px 10px', fontSize: 11, borderRadius: 999, fontWeight: 500,
                color: colors.fg, background: colors.bg, border: `1px solid ${colors.fg}30`,
                whiteSpace: 'nowrap',
              }}>
                {RECEIVABLE_SOURCE_LABELS[row.source]}
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
                {row.reference}
                <ExternalLink size={11} style={{ opacity: 0.6 }} />
              </span>
            </div>

            {/* CLIENT — v0.7.7: visuell als Link erkennbar (Underline +
                ExternalLink-Icon analog zur Reference-Spalte). Klick navigiert
                zum Client-Detail. */}
            <div style={{ minWidth: 0 }}>
              {row.customerId ? (
                <span
                  onClick={(e) => { e.stopPropagation(); navigate(`/clients/${row.customerId}`); }}
                  className="cursor-pointer"
                  style={{
                    fontSize: 14, color: '#0F0F10',
                    textDecoration: 'underline',
                    textUnderlineOffset: 3,
                    textDecorationColor: 'rgba(15,15,16,0.20)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = '#3D7FFF';
                    e.currentTarget.style.textDecorationColor = 'rgba(61,127,255,0.50)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = '#0F0F10';
                    e.currentTarget.style.textDecorationColor = 'rgba(15,15,16,0.20)';
                  }}
                  title={`Open ${row.customerName}`}
                >
                  {row.customerName}
                  <ExternalLink size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
                </span>
              ) : (
                <span style={{ fontSize: 14, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                  {row.customerName}
                </span>
              )}
            </div>

            {/* ISSUED */}
            <div style={{ fontSize: 12, color: '#4B5563', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtDate(row.issuedAt)}
            </div>

            {/* AMOUNT (gross original) */}
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 13, color: '#6B7280', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Bhd v={row.totalAmount}/></div>
              {row.paidAmount > 0 && (
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>
                  paid <Bhd v={row.paidAmount}/>
                </div>
              )}
            </div>

            {/* OUTSTANDING */}
            <div className="font-mono" style={{
              textAlign: 'right', fontSize: 14, fontWeight: 600,
              color: row.daysOverdue > 0 ? '#DC2626' : '#0F0F10',
              minWidth: 0, overflow: 'hidden',
            }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Bhd v={row.open}/></div>
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
            Showing {filtered.length} of {allRows.length} receivables
          </div>
          <div className="font-mono" style={{ textAlign: 'right', fontSize: 13, color: '#6B7280' }}>
            {fmt(filtered.reduce((s, r) => s + r.totalAmount, 0))}
          </div>
          <div className="font-mono" style={{ textAlign: 'right', fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>
            {fmt(filtered.reduce((s, r) => s + r.open, 0))} <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>BHD</span>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
