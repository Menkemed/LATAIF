import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight, ArrowDownLeft, HandCoins, Plus, Wallet, Building2, Trash2, Smartphone,
  AlertTriangle, Calendar, Clock, Download, FileText, X,
} from 'lucide-react';
import { StaffSelect } from '@/components/employees/StaffSelect';
import { StaffFilterPill } from '@/components/employees/StaffFilterPill';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useDebtStore } from '@/stores/debtStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Debt, DebtDirection, CashSource } from '@/core/models/types';
import { canonicalLoanStatus, isLoanGiven } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function fmtDate(iso?: string): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

type Filter = 'all' | 'open' | 'settled' | 'partial' | 'we_lend' | 'we_borrow';

// Plan §Loan §10: Status-Normalisierung für UI (akzeptiert legacy + canonical)
function isOpen(d: Debt): boolean {
  const s = canonicalLoanStatus(d.status, d.amount, d.paidAmount);
  return s === 'OPEN' || s === 'PARTIALLY_REPAID';
}
function isSettled(d: Debt): boolean {
  return canonicalLoanStatus(d.status, d.amount, d.paidAmount) === 'REPAID';
}
function isPartial(d: Debt): boolean {
  return canonicalLoanStatus(d.status, d.amount, d.paidAmount) === 'PARTIALLY_REPAID';
}

// ── Aging (spiegelt receivables.ts) ───────────────────────────
type AgeBucket = 'current' | '1-30' | '31-60' | '60+';

function computeDaysOverdue(dueAt: string | null | undefined, issuedAt: string | undefined): number {
  // Wenn kein Faelligkeitsdatum gesetzt ist, gilt der Loan als nicht ueberfaellig (current).
  // Issuedauer wird optional angezeigt aber nicht fuer Aging gewertet — sonst waere jeder
  // Loan ohne dueDate sofort ueberfaellig was nicht stimmt.
  if (!dueAt) return 0;
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return 0;
  const now = Date.now();
  return Math.floor((now - due) / (1000 * 60 * 60 * 24));
  // issuedAt wird hier ignoriert; vorgesehen fuer ein spaeteres Aging "by issue date"-Mode falls gewuenscht.
  void issuedAt;
}

function bucketFor(days: number): AgeBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  return '60+';
}

const BUCKET_META: Record<AgeBucket, { label: string; fg: string; bg: string }> = {
  'current': { label: 'Current',    fg: '#16A34A', bg: 'rgba(22,163,74,0.08)' },
  '1-30':    { label: '1–30 days',  fg: '#FF8730', bg: 'rgba(255,135,48,0.10)' },
  '31-60':   { label: '31–60 days', fg: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  '60+':     { label: '60+ days',   fg: '#7F1D1D', bg: 'rgba(127,29,29,0.10)' },
};

function ageLabel(daysOverdue: number, hasDue: boolean): { text: string; color: string } {
  if (daysOverdue > 0) return { text: `${daysOverdue} days overdue`, color: daysOverdue > 60 ? '#7F1D1D' : daysOverdue > 30 ? '#DC2626' : '#FF8730' };
  if (daysOverdue === 0) return { text: hasDue ? 'Due today' : 'No due date', color: hasDue ? '#FF8730' : '#6B7280' };
  return { text: hasDue ? `in ${Math.abs(daysOverdue)} days` : 'No due date', color: '#6B7280' };
}

// ── Direction-Meta (Pill-Farben analog Receivables-Sources) ────
const DIRECTION_META: Record<'GIVEN' | 'TAKEN', { label: string; fg: string; bg: string }> = {
  GIVEN: { label: 'Loan Given', fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
  TAKEN: { label: 'Loan Taken', fg: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
};

interface DebtRow {
  debt: Debt;
  direction: 'GIVEN' | 'TAKEN';
  remaining: number;
  daysOverdue: number;
  bucket: AgeBucket;
  customerName: string;
}

function downloadCsv(rows: DebtRow[]) {
  const header = ['Direction', 'Loan #', 'Counterparty', 'Issued', 'Due', 'Days Overdue', 'Amount (BHD)', 'Paid (BHD)', 'Remaining (BHD)', 'Status'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const d = r.debt;
    const status = canonicalLoanStatus(d.status, d.amount, d.paidAmount);
    const cells = [
      DIRECTION_META[r.direction].label,
      d.loanNumber || d.id,
      `"${(r.customerName || '').replace(/"/g, '""')}"`,
      (d.createdAt || '').split('T')[0],
      d.dueDate ? d.dueDate.split('T')[0] : '',
      String(r.daysOverdue),
      d.amount.toFixed(3),
      d.paidAmount.toFixed(3),
      r.remaining.toFixed(3),
      status,
    ];
    lines.push(cells.join(','));
  }
  const csv = lines.join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `debts-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function DebtsPage() {
  const navigate = useNavigate();
  const { debts, loadDebts, createDebt, updateDebt, deleteDebt,
          paymentsByDebt, loadPaymentsForDebt, recordDebtPayment } = useDebtStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { loadEmployees } = useEmployeeStore();
  const [overdueOnly, setOverdueOnly] = useState(false);

  // Plan §Filter — Dashboard-Klick übergibt ?direction=MONEY_GIVEN/MONEY_RECEIVED → in lokalen Filter mappen.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter: Filter = (() => {
    const dir = searchParams.get('direction');
    if (dir === 'MONEY_GIVEN') return 'we_lend';
    if (dir === 'MONEY_RECEIVED') return 'we_borrow';
    const f = searchParams.get('filter') as Filter;
    if (f && ['all', 'open', 'settled', 'partial', 'we_lend', 'we_borrow'].includes(f)) return f;
    return 'all';
  })();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('direction');
    if (filter && filter !== 'all') next.set('filter', filter); else next.delete('filter');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [filter, searchParams, setSearchParams]);

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({
    direction: 'we_lend' as DebtDirection,
    counterparty: '',
    customerId: '',
    amount: '',
    source: 'cash' as CashSource,
    dueDate: '',
    notes: '',
    staffId: '',
  });

  const [detailId, setDetailId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [paySource, setPaySource] = useState<CashSource>('cash');
  const [payDate, setPayDate] = useState('');
  const [payNote, setPayNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [editDebt, setEditDebt] = useState(false);
  const [editForm, setEditForm] = useState<{ counterparty: string; amount: string; dueDate: string; notes: string; source: CashSource }>({
    counterparty: '', amount: '', dueDate: '', notes: '', source: 'cash',
  });

  useEffect(() => { loadDebts(); loadCustomers(); loadEmployees(); }, [loadDebts, loadCustomers, loadEmployees]);

  useEffect(() => {
    if (detailId) {
      loadPaymentsForDebt(detailId);
      setPayAmount('');
      setPaySource('cash');
      setPayDate(new Date().toISOString().split('T')[0]);
      setPayNote('');
    }
  }, [detailId, loadPaymentsForDebt]);

  const getCustomer = (id?: string) => id ? customers.find(c => c.id === id) : undefined;

  // URL-Param: /debts?customer=:id → nur Loans dieses Kunden anzeigen.
  const customerFilter = searchParams.get('customer') || '';
  const staffFilter = searchParams.get('staff') || '';

  // Rich rows: jede Debt wird zu einer DebtRow mit Aging-Werten angereichert.
  // Filter-Reihenfolge: customer/staff (URL) -> direction/status (Filter-Pills) -> overdue -> search.
  const filtered: DebtRow[] = useMemo(() => {
    let r = debts;
    if (customerFilter) r = r.filter(d => d.customerId === customerFilter);
    if (staffFilter) r = r.filter(d => d.staffId === staffFilter);
    if (filter === 'open') r = r.filter(isOpen);
    else if (filter === 'settled') r = r.filter(isSettled);
    else if (filter === 'partial') r = r.filter(isPartial);
    else if (filter === 'we_lend') r = r.filter(d => isLoanGiven(d.direction));
    else if (filter === 'we_borrow') r = r.filter(d => !isLoanGiven(d.direction));
    if (search) r = r.filter(d => matchesDeep(d, search, [getCustomer(d.customerId)]));
    const rows: DebtRow[] = r.map(d => {
      const remaining = Math.max(0, d.amount - d.paidAmount);
      const daysOverdue = computeDaysOverdue(d.dueDate, d.createdAt);
      const cust = getCustomer(d.customerId);
      return {
        debt: d,
        direction: isLoanGiven(d.direction) ? 'GIVEN' : 'TAKEN',
        remaining,
        daysOverdue,
        bucket: bucketFor(daysOverdue),
        customerName: cust ? `${cust.firstName} ${cust.lastName}`.trim() : (d.counterparty || '—'),
      };
    });
    const finalRows = overdueOnly ? rows.filter(x => x.daysOverdue > 0 && isOpen(x.debt)) : rows;
    // Sort: am staerksten ueberfaellig zuerst, dann nach remaining desc.
    finalRows.sort((a, b) => {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return b.remaining - a.remaining;
    });
    return finalRows;
  }, [debts, filter, search, customers, customerFilter, staffFilter, overdueOnly]);

  // KPIs — robust gegen Legacy-Direction ('we_lend'/'we_borrow') und kanonische ('MONEY_GIVEN'/'MONEY_RECEIVED').
  const openLent = debts.filter(d => isLoanGiven(d.direction) && isOpen(d))
                        .reduce((s, d) => s + (d.amount - d.paidAmount), 0);
  const openBorrowed = debts.filter(d => !isLoanGiven(d.direction) && isOpen(d))
                            .reduce((s, d) => s + (d.amount - d.paidAmount), 0);

  // Aging-Buckets (nur OPEN/PARTIAL; settled raus, sonst zaehlt repaid quasi "current" mit).
  const openRowsAll: DebtRow[] = useMemo(() => debts
    .filter(isOpen)
    .map(d => {
      const remaining = Math.max(0, d.amount - d.paidAmount);
      const daysOverdue = computeDaysOverdue(d.dueDate, d.createdAt);
      return { debt: d, direction: isLoanGiven(d.direction) ? 'GIVEN' as const : 'TAKEN' as const,
               remaining, daysOverdue, bucket: bucketFor(daysOverdue),
               customerName: getCustomer(d.customerId)?.firstName || d.counterparty || '' };
    }), [debts, customers]);
  const buckets = useMemo(() => {
    const out: Record<AgeBucket, { total: number; count: number }> = {
      current: { total: 0, count: 0 },
      '1-30':   { total: 0, count: 0 },
      '31-60':  { total: 0, count: 0 },
      '60+':    { total: 0, count: 0 },
    };
    for (const r of openRowsAll) { out[r.bucket].total += r.remaining; out[r.bucket].count++; }
    return out;
  }, [openRowsAll]);
  const totalOpen = openRowsAll.reduce((s, r) => s + r.remaining, 0);
  const overdueN = openRowsAll.filter(r => r.daysOverdue > 0).length;

  function resetForm() {
    setForm({
      direction: 'we_lend', counterparty: '', customerId: '',
      amount: '', source: 'cash', dueDate: '', notes: '', staffId: '',
    });
  }

  function handleCreate() {
    const amt = parseFloat(form.amount);
    // Industry-Standard: Jeder Loan/Debt MUSS einem Client zugeordnet sein,
    // damit er korrekt in der Customer-Receivables-Übersicht erscheint.
    if (!form.customerId) {
      alert('Please select a client. Every loan must be linked to a customer.');
      return;
    }
    if (!amt || amt <= 0) {
      alert('Amount must be greater than zero.');
      return;
    }
    const cust = getCustomer(form.customerId);
    createDebt({
      direction: form.direction,
      counterparty: cust ? `${cust.firstName} ${cust.lastName}`.trim() : (form.counterparty.trim() || ''),
      customerId: form.customerId,
      amount: amt,
      source: form.source,
      dueDate: form.dueDate || undefined,
      notes: form.notes.trim() || undefined,
      staffId: form.staffId || undefined,
    });
    setShowNew(false);
    resetForm();
  }

  function handlePay() {
    if (!detailId) return;
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) return;
    recordDebtPayment(detailId, amt, paySource, payDate + 'T00:00:00Z', payNote.trim() || undefined);
    setPayAmount('');
    setPayNote('');
  }

  const detail: Debt | undefined = debts.find(d => d.id === detailId);
  const detailCustomer = detail ? getCustomer(detail.customerId) : undefined;
  const detailPayments = detailId ? (paymentsByDebt[detailId] || []) : [];
  const detailRemaining = detail ? Math.max(0, detail.amount - detail.paidAmount) : 0;

  return (
    <PageLayout
      title="Debts"
      subtitle={`${openRowsAll.length} open \u00b7 ${overdueN} overdue \u00b7 ${fmt(totalOpen)} BHD total`}
      showSearch onSearch={setSearch} searchPlaceholder="Search counterparty, notes..."
      actions={
        <div className="flex items-center gap-2">
          <StaffFilterPill />
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
          <Button variant="primary" onClick={() => setShowNew(true)}><Plus size={14} /> New Debt</Button>
        </div>
      }
    >
      {/* ── Aging buckets (über alle OPEN debts) ── */}
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
                <Bhd v={data.total}/> <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
              </div>
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                {data.count} {data.count === 1 ? 'loan' : 'loans'}
              </div>
            </Card>
          );
        })}
      </div>

      {/* ── Filter bar (Direction- + Status-Chips + Overdue Toggle + Reset) ── */}
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 4 }}>Direction</span>
        {([
          { id: 'we_lend' as Filter,   dirKey: 'GIVEN' as const },
          { id: 'we_borrow' as Filter, dirKey: 'TAKEN' as const },
        ]).map(({ id, dirKey }) => {
          const meta = DIRECTION_META[dirKey];
          const active = filter === id;
          return (
            <button
              key={id}
              onClick={() => setFilter(active ? 'all' : id)}
              className="cursor-pointer transition-all duration-150"
              style={{
                padding: '5px 12px', fontSize: 12, borderRadius: 999, fontWeight: 500,
                color: active ? meta.fg : '#6B7280',
                background: active ? meta.bg : 'transparent',
                border: `1px solid ${active ? meta.fg + '40' : '#D5D9DE'}`,
              }}
            >
              {meta.label}
            </button>
          );
        })}
        <span style={{ width: 1, height: 18, background: '#E5E9EE', margin: '0 6px' }} />
        <span style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 4 }}>Status</span>
        {([
          { id: 'open' as Filter,    label: 'Open' },
          { id: 'partial' as Filter, label: 'Partial' },
          { id: 'settled' as Filter, label: 'Repaid' },
        ]).map(({ id, label }) => {
          const active = filter === id;
          return (
            <button
              key={id}
              onClick={() => setFilter(active ? 'all' : id)}
              className="cursor-pointer transition-all duration-150"
              style={{
                padding: '5px 12px', fontSize: 12, borderRadius: 999, fontWeight: 500,
                color: active ? '#0F0F10' : '#6B7280',
                background: active ? 'rgba(15,15,16,0.08)' : 'transparent',
                border: `1px solid ${active ? 'rgba(15,15,16,0.20)' : '#D5D9DE'}`,
              }}
            >
              {label}
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
        {(filter !== 'all' || overdueOnly || search) && (
          <button
            onClick={() => { setFilter('all'); setOverdueOnly(false); setSearch(''); }}
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
        gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr)',
        gap: 16, padding: '0 16px 12px',
      }}>
        <span className="text-overline">DUE / AGE</span>
        <span className="text-overline">DIRECTION</span>
        <span className="text-overline">REFERENCE</span>
        <span className="text-overline">COUNTERPARTY</span>
        <span className="text-overline">ISSUED</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>AMOUNT</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>OUTSTANDING</span>
      </div>
      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <HandCoins size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {debts.length === 0 ? 'No debts yet. Add your first loan.' : 'No debts match this filter.'}
          </p>
        </div>
      )}

      {filtered.map(row => {
        const d = row.debt;
        const settled = isSettled(d);
        const meta = DIRECTION_META[row.direction];
        const age = ageLabel(row.daysOverdue, !!d.dueDate);
        return (
          <div
            key={d.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr)',
              gap: 16, padding: '14px 16px', alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => setDetailId(d.id)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {/* DUE / AGE */}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: settled ? '#7EAA6E' : age.color, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {settled ? 'Repaid' : age.text}
              </div>
              <div className="flex items-center gap-1" style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>
                <Calendar size={10} /> {d.dueDate ? fmtDate(d.dueDate) : '—'}
              </div>
            </div>

            {/* DIRECTION */}
            <div style={{ minWidth: 0 }}>
              <span style={{
                padding: '3px 10px', fontSize: 11, borderRadius: 999, fontWeight: 500,
                color: meta.fg, background: meta.bg, border: `1px solid ${meta.fg}30`,
                whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                {row.direction === 'GIVEN' ? <ArrowUpRight size={11} /> : <ArrowDownLeft size={11} />}
                {meta.label}
              </span>
              <div className="flex items-center gap-1" style={{ fontSize: 10, color: '#9CA3AF', marginTop: 4 }}>
                {d.source === 'cash' ? <Wallet size={10} /> : d.source === 'bank' ? <Building2 size={10} /> : <Smartphone size={10} />}
                {d.source === 'cash' ? 'Cash' : d.source === 'bank' ? 'Bank' : 'Benefit'}
              </div>
            </div>

            {/* REFERENCE (Loan number) */}
            <div style={{ minWidth: 0 }}>
              <span className="font-mono" style={{
                fontSize: 13, color: '#3D7FFF', textDecoration: 'underline',
                textUnderlineOffset: 3, textDecorationColor: 'rgba(61,127,255,0.30)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                display: 'inline-block',
              }}>
                {d.loanNumber || d.id.slice(0, 8)}
              </span>
              {d.notes && (
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.notes}
                </div>
              )}
            </div>

            {/* COUNTERPARTY */}
            <div style={{ minWidth: 0 }}>
              {d.customerId ? (
                <span
                  onClick={(e) => { e.stopPropagation(); navigate(`/clients/${d.customerId}`); }}
                  className="cursor-pointer"
                  style={{
                    fontSize: 14, color: '#0F0F10',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    display: 'block',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#3D7FFF'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = '#0F0F10'; }}
                >
                  {row.customerName}
                </span>
              ) : (
                <span style={{ fontSize: 14, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                  {row.customerName}
                </span>
              )}
            </div>

            {/* ISSUED */}
            <div style={{ fontSize: 12, color: '#4B5563', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtDate(d.createdAt)}
            </div>

            {/* AMOUNT */}
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 13, color: '#6B7280', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Bhd v={d.amount}/></div>
              {d.paidAmount > 0 && (
                <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>
                  paid <Bhd v={d.paidAmount}/>
                </div>
              )}
            </div>

            {/* OUTSTANDING */}
            <div className="font-mono" style={{
              textAlign: 'right', fontSize: 14, fontWeight: 600,
              color: settled ? '#7EAA6E' : (row.daysOverdue > 0 ? '#DC2626' : '#0F0F10'),
              minWidth: 0, overflow: 'hidden',
            }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {settled ? '—' : <Bhd v={row.remaining}/>}
              </div>
              <div style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 400, marginTop: 2 }}>BHD</div>
            </div>
          </div>
        );
      })}

      {/* ── Footer total ── */}
      {filtered.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr)',
          gap: 16, padding: '20px 16px 8px',
          borderTop: '2px solid #E5E9EE', marginTop: 8,
        }}>
          <div style={{ gridColumn: 'span 5', fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={14} />
            Showing {filtered.length} of {debts.length} debts · Given <Bhd v={openLent}/> · Taken <Bhd v={openBorrowed}/> BHD open
          </div>
          <div className="font-mono" style={{ textAlign: 'right', fontSize: 13, color: '#6B7280' }}>
            <Bhd v={filtered.reduce((s, r) => s + r.debt.amount, 0)}/>
          </div>
          <div className="font-mono" style={{ textAlign: 'right', fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>
            <Bhd v={filtered.reduce((s, r) => s + r.remaining, 0)}/> <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>BHD</span>
          </div>
        </div>
      )}

      {/* New Debt Modal */}
      <Modal open={showNew} onClose={() => { setShowNew(false); resetForm(); }} title="New Debt" width={540}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>DIRECTION</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {([
                { id: 'we_lend' as DebtDirection, label: 'We lend to someone', icon: <ArrowUpRight size={14} /> },
                { id: 'we_borrow' as DebtDirection, label: 'We borrow from someone', icon: <ArrowDownLeft size={14} /> },
              ]).map(opt => (
                <button key={opt.id} onClick={() => setForm(f => ({ ...f, direction: opt.id }))}
                  className="cursor-pointer rounded flex-1 flex items-center gap-2 justify-center" style={{
                    padding: '10px 14px', fontSize: 12,
                    border: `1px solid ${form.direction === opt.id ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.direction === opt.id ? '#0F0F10' : '#4B5563',
                    background: form.direction === opt.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {opt.icon}{opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <SearchSelect
              label="CLIENT *"
              placeholder="Search and select a client (required)"
              options={customers.map(c => ({ id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone }))}
              value={form.customerId}
              onChange={id => {
                const c = customers.find(cc => cc.id === id);
                setForm(f => ({ ...f, customerId: id, counterparty: c ? `${c.firstName} ${c.lastName}`.trim() : f.counterparty }));
              }}
            />
            <span style={{ fontSize: 11, color: '#6B7280', marginTop: 4, display: 'block' }}>
              Every loan must be linked to a client so it shows up in their account.
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input required label="AMOUNT (BHD)" type="number" step="0.001"
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            <Input label="DUE DATE (optional)" type="date"
              value={form.dueDate}
              onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
          </div>

          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>{form.direction === 'we_lend' ? 'PAID FROM' : 'RECEIVED INTO'}</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {(['cash', 'bank', 'benefit'] as CashSource[]).map(s => (
                <button key={s} onClick={() => setForm(f => ({ ...f, source: s }))}
                  className="cursor-pointer rounded flex items-center gap-2" style={{
                    padding: '8px 18px', fontSize: 12,
                    border: `1px solid ${form.source === s ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.source === s ? '#0F0F10' : '#6B7280',
                    background: form.source === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {s === 'cash' ? <Wallet size={12} /> : s === 'bank' ? <Building2 size={12} /> : <Smartphone size={12} style={{ color: '#FF8730' }} />}
                  {s === 'cash' ? 'Cash' : s === 'bank' ? 'Bank' : 'Benefit'}
                </button>
              ))}
            </div>
          </div>

          <Input label="NOTES (optional)"
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />

          <StaffSelect value={form.staffId} onChange={(id) => setForm(f => ({ ...f, staffId: id }))}
            helper="Who handled this loan/debt (optional)." />

          <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setShowNew(false); resetForm(); }}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}>Create Debt</Button>
          </div>
        </div>
      </Modal>

      {/* Debt Detail Modal */}
      <Modal open={!!detailId} onClose={() => setDetailId(null)} title={detail ? `${detail.direction === 'we_lend' ? 'We Lent' : 'We Borrowed'} — ${detailCustomer ? detailCustomer.firstName + ' ' + detailCustomer.lastName : detail.counterparty}` : ''} width={620}>
        {detail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '70vh', overflowY: 'auto' }}>
            {/* Summary */}
            <div style={{ padding: '14px 18px', background: '#F2F7FA', borderRadius: 10, border: '1px solid #E5E9EE' }}>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>Original amount</span>
                <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={detail.amount}/> BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>Paid so far</span>
                <span className="font-mono" style={{ color: '#7EAA6E' }}><Bhd v={detail.paidAmount}/> BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 13, paddingTop: 6, borderTop: '1px solid #E5E9EE', marginTop: 6 }}>
                <span style={{ color: '#0F0F10' }}>Remaining</span>
                <span className="font-mono" style={{ color: isSettled(detail) ? '#7EAA6E' : '#AA6E6E' }}><Bhd v={detailRemaining}/> BHD</span>
              </div>
              {detail.dueDate && (
                <div className="flex justify-between" style={{ fontSize: 11, marginTop: 8, color: '#6B7280' }}>
                  <span>Due</span>
                  <span>{fmtDate(detail.dueDate)}</span>
                </div>
              )}
              {detail.notes && (
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8, lineHeight: 1.5 }}>{detail.notes}</div>
              )}
            </div>

            {/* Payments history */}
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>REPAYMENTS · {detailPayments.length}</span>
              {detailPayments.length === 0 && (
                <p style={{ fontSize: 12, color: '#6B7280', marginTop: 8 }}>No repayments yet.</p>
              )}
              {detailPayments.map(p => (
                <div key={p.id} className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE', fontSize: 12 }}>
                  <div className="flex items-center gap-2">
                    {p.source === 'cash' ? <Wallet size={12} style={{ color: '#4B5563' }} /> : <Building2 size={12} style={{ color: '#4B5563' }} />}
                    <span style={{ color: '#4B5563' }}>{fmtDate(p.paidAt)}</span>
                    {p.notes && <span style={{ color: '#6B7280' }}>· {p.notes}</span>}
                  </div>
                  <span className="font-mono" style={{ color: '#7EAA6E' }}><Bhd v={p.amount}/> BHD</span>
                </div>
              ))}
            </div>

            {/* Record payment form */}
            {!isSettled(detail) && (
              <div style={{ padding: '14px 18px', border: '1px solid #D5D9DE', borderRadius: 10 }}>
                <span className="text-overline" style={{ marginBottom: 10 }}>RECORD REPAYMENT</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                  <Input required label="AMOUNT (BHD)" type="number" step="0.001"
                    value={payAmount}
                    onChange={e => setPayAmount(e.target.value)} />
                  <Input required label="DATE" type="date"
                    value={payDate}
                    onChange={e => setPayDate(e.target.value)} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <span className="text-overline" style={{ marginBottom: 6 }}>{detail.direction === 'we_lend' ? 'RECEIVED INTO' : 'PAID FROM'}</span>
                  <div className="flex gap-2" style={{ marginTop: 8 }}>
                    {(['cash', 'bank', 'benefit'] as CashSource[]).map(s => (
                      <button key={s} onClick={() => setPaySource(s)}
                        className="cursor-pointer rounded flex items-center gap-2" style={{
                          padding: '6px 14px', fontSize: 12,
                          border: `1px solid ${paySource === s ? '#0F0F10' : '#D5D9DE'}`,
                          color: paySource === s ? '#0F0F10' : '#6B7280',
                          background: paySource === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>
                        {s === 'cash' ? <Wallet size={12} /> : <Building2 size={12} />}
                        {s === 'cash' ? 'Cash' : 'Bank'}
                      </button>
                    ))}
                  </div>
                </div>
                <Input label="NOTE (optional)" value={payNote} onChange={e => setPayNote(e.target.value)} style={{ marginTop: 10 }} />
                <div className="flex justify-end" style={{ marginTop: 12 }}>
                  <Button variant="primary" onClick={handlePay} disabled={!payAmount || parseFloat(payAmount) <= 0}>Record Repayment</Button>
                </div>
              </div>
            )}

            <div className="flex justify-between" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="danger" onClick={() => setConfirmDelete(detail.id)}><Trash2 size={14} /> Delete</Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => {
                  setEditForm({
                    counterparty: detail.counterparty,
                    amount: String(detail.amount),
                    dueDate: detail.dueDate || '',
                    notes: detail.notes || '',
                    source: detail.source,
                  });
                  setEditDebt(true);
                }}>Edit</Button>
                <Button variant="ghost" onClick={() => setHistoryId(detail.id)}>History</Button>
                <Button variant="ghost" onClick={() => setDetailId(null)}>Close</Button>
              </div>
            </div>

            {/* Inline Edit Form */}
            {editDebt && (
              <div style={{ padding: '14px 18px', border: '1px solid #D5D9DE', borderRadius: 10, marginTop: 12 }}>
                <span className="text-overline" style={{ marginBottom: 10 }}>EDIT DEBT</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  <Input required label="COUNTERPARTY" value={editForm.counterparty}
                    onChange={e => setEditForm({ ...editForm, counterparty: e.target.value })} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <Input required label="AMOUNT (BHD)" type="number" step="0.001" value={editForm.amount}
                      onChange={e => setEditForm({ ...editForm, amount: e.target.value })} />
                    <Input label="DUE DATE" type="date" value={editForm.dueDate}
                      onChange={e => setEditForm({ ...editForm, dueDate: e.target.value })} />
                  </div>
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>SOURCE</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
                      {(['cash', 'bank', 'benefit'] as CashSource[]).map(s => (
                        <button key={s} onClick={() => setEditForm({ ...editForm, source: s })}
                          className="cursor-pointer rounded"
                          style={{ padding: '6px 14px', fontSize: 12,
                            border: `1px solid ${editForm.source === s ? '#0F0F10' : '#D5D9DE'}`,
                            color: editForm.source === s ? '#0F0F10' : '#6B7280',
                            background: editForm.source === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}>{s === 'cash' ? 'Cash' : s === 'bank' ? 'Bank' : 'Benefit'}</button>
                      ))}
                    </div>
                  </div>
                  <Input label="NOTES" value={editForm.notes}
                    onChange={e => setEditForm({ ...editForm, notes: e.target.value })} />
                  <div className="flex justify-end gap-2" style={{ marginTop: 8 }}>
                    <Button variant="ghost" onClick={() => setEditDebt(false)}>Cancel</Button>
                    <Button variant="primary" onClick={() => {
                      updateDebt(detail.id, {
                        counterparty: editForm.counterparty,
                        amount: parseFloat(editForm.amount) || 0,
                        dueDate: editForm.dueDate || undefined,
                        notes: editForm.notes || undefined,
                        source: editForm.source,
                      });
                      setEditDebt(false);
                    }}>Save</Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <HistoryDrawer
        open={!!historyId}
        onClose={() => setHistoryId(null)}
        entityType="debts"
        entityId={historyId || ''}
        title="Debt History"
      />

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Debt?" width={420}>
        <div>
          <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 20 }}>This deletes the debt and all recorded repayments. Cannot be undone.</p>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => {
              if (confirmDelete) {
                deleteDebt(confirmDelete);
                if (detailId === confirmDelete) setDetailId(null);
                setConfirmDelete(null);
              }
            }}>Delete</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
