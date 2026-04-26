import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ArrowDownLeft, HandCoins, Plus, Wallet, Building2, Trash2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useDebtStore } from '@/stores/debtStore';
import { useCustomerStore } from '@/stores/customerStore';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Debt, DebtDirection, CashSource } from '@/core/models/types';
import { canonicalLoanStatus } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

export function DebtsPage() {
  const { debts, loadDebts, createDebt, updateDebt, deleteDebt,
          paymentsByDebt, loadPaymentsForDebt, recordDebtPayment } = useDebtStore();
  const { customers, loadCustomers } = useCustomerStore();

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({
    direction: 'we_lend' as DebtDirection,
    counterparty: '',
    customerId: '',
    amount: '',
    source: 'cash' as CashSource,
    dueDate: '',
    notes: '',
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

  useEffect(() => { loadDebts(); loadCustomers(); }, [loadDebts, loadCustomers]);

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

  const filtered = useMemo(() => {
    let r = debts;
    if (filter === 'open') r = r.filter(isOpen);
    else if (filter === 'settled') r = r.filter(isSettled);
    else if (filter === 'partial') r = r.filter(isPartial);
    else if (filter === 'we_lend') r = r.filter(d => d.direction === 'we_lend');
    else if (filter === 'we_borrow') r = r.filter(d => d.direction === 'we_borrow');
    if (search) r = r.filter(d => matchesDeep(d, search, [getCustomer(d.customerId)]));
    return r;
  }, [debts, filter, search, customers]);

  // KPIs
  const openLent = debts.filter(d => d.direction === 'we_lend' && isOpen(d))
                        .reduce((s, d) => s + (d.amount - d.paidAmount), 0);
  const openBorrowed = debts.filter(d => d.direction === 'we_borrow' && isOpen(d))
                            .reduce((s, d) => s + (d.amount - d.paidAmount), 0);

  function resetForm() {
    setForm({
      direction: 'we_lend', counterparty: '', customerId: '',
      amount: '', source: 'cash', dueDate: '', notes: '',
    });
  }

  function handleCreate() {
    const amt = parseFloat(form.amount);
    if (!form.counterparty.trim() && !form.customerId) {
      alert('Please provide a counterparty name or select a customer.');
      return;
    }
    if (!amt || amt <= 0) {
      alert('Amount must be greater than zero.');
      return;
    }
    createDebt({
      direction: form.direction,
      counterparty: form.counterparty.trim() || (getCustomer(form.customerId)
        ? `${getCustomer(form.customerId)!.firstName} ${getCustomer(form.customerId)!.lastName}` : ''),
      customerId: form.customerId || undefined,
      amount: amt,
      source: form.source,
      dueDate: form.dueDate || undefined,
      notes: form.notes.trim() || undefined,
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
      subtitle={`${debts.length} entries \u00b7 open: ${debts.filter(isOpen).length}`}
      showSearch onSearch={setSearch} searchPlaceholder="Search counterparty, notes..."
      actions={
        <Button variant="primary" onClick={() => setShowNew(true)}><Plus size={14} /> New Debt</Button>
      }
    >
      {/* KPI Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div style={{ padding: '16px 20px', background: '#FFFFFF', border: '1px solid #E5E1D6', borderRadius: 12 }}>
          <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
            <ArrowUpRight size={14} style={{ color: '#AA956E' }} />
            <span className="text-overline">OWED TO US</span>
          </div>
          <div className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}>{fmt(openLent)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span></div>
        </div>
        <div style={{ padding: '16px 20px', background: '#FFFFFF', border: '1px solid #E5E1D6', borderRadius: 12 }}>
          <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
            <ArrowDownLeft size={14} style={{ color: '#AA6E6E' }} />
            <span className="text-overline">WE OWE</span>
          </div>
          <div className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}>{fmt(openBorrowed)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span></div>
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex gap-2" style={{ marginBottom: 16 }}>
        {([
          { id: 'all', label: 'All' },
          { id: 'open', label: 'Open' },
          { id: 'partial', label: 'Partially Repaid' },
          { id: 'settled', label: 'Repaid' },
          { id: 'we_lend', label: 'We Lend' },
          { id: 'we_borrow', label: 'We Borrow' },
        ] as { id: Filter; label: string }[]).map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className="cursor-pointer" style={{
              padding: '6px 14px', fontSize: 11, borderRadius: 999, border: 'none',
              background: filter === f.id ? 'rgba(15,15,16,0.08)' : 'transparent',
              color: filter === f.id ? '#0F0F10' : '#6B7280',
            }}>{f.label}</button>
        ))}
      </div>

      {/* Table Header */}
      <div style={{ display: 'grid', gridTemplateColumns: '36px 1.6fr 0.8fr 1fr 1fr 1fr 0.8fr 80px', gap: 12, padding: '0 12px 10px' }}>
        {['', 'COUNTERPARTY', 'SOURCE', 'AMOUNT', 'PAID', 'REMAINING', 'DUE', 'STATUS'].map(h => (
          <span key={h} className="text-overline">{h}</span>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #E5E1D6' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <HandCoins size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>No debts match this filter.</p>
        </div>
      )}

      {filtered.map(d => {
        const remaining = Math.max(0, d.amount - d.paidAmount);
        const settled = isSettled(d);
        const isWeLend = d.direction === 'we_lend';
        const cust = getCustomer(d.customerId);
        return (
          <div key={d.id}
            className="cursor-pointer transition-colors"
            onClick={() => setDetailId(d.id)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            style={{
              display: 'grid', gridTemplateColumns: '36px 1.6fr 0.8fr 1fr 1fr 1fr 0.8fr 80px',
              gap: 12, padding: '14px 12px', alignItems: 'center',
              borderBottom: '1px solid #E5E1D6',
            }}>
            <div className="flex items-center justify-center" title={isWeLend ? 'We lend' : 'We borrow'}
              style={{ width: 28, height: 28, borderRadius: 8,
                       background: isWeLend ? 'rgba(170,149,110,0.08)' : 'rgba(220,38,38,0.08)' }}>
              {isWeLend
                ? <ArrowUpRight size={14} style={{ color: '#AA956E' }} />
                : <ArrowDownLeft size={14} style={{ color: '#AA6E6E' }} />}
            </div>
            <div>
              <div style={{ fontSize: 13, color: '#0F0F10' }}>
                {cust ? `${cust.firstName} ${cust.lastName}` : d.counterparty || '—'}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                {d.loanNumber && (
                  <span className="font-mono" style={{ fontSize: 10, color: '#6B7280', padding: '1px 6px', border: '1px solid #D5D1C4', borderRadius: 4 }}>
                    {d.loanNumber}
                  </span>
                )}
                {d.notes && <span style={{ fontSize: 11, color: '#6B7280', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.notes}</span>}
              </div>
            </div>
            <div className="flex items-center gap-1" style={{ fontSize: 12, color: '#4B5563' }}>
              {d.source === 'cash' ? <Wallet size={12} /> : <Building2 size={12} />}
              {d.source === 'cash' ? 'Cash' : 'Bank'}
            </div>
            <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(d.amount)}</span>
            <span className="font-mono" style={{ fontSize: 13, color: d.paidAmount > 0 ? '#7EAA6E' : '#6B7280' }}>{fmt(d.paidAmount)}</span>
            <span className="font-mono" style={{ fontSize: 13, color: settled ? '#7EAA6E' : '#AA956E' }}>
              {settled ? '—' : fmt(remaining)}
            </span>
            <span style={{ fontSize: 12, color: '#6B7280' }}>{fmtDate(d.dueDate)}</span>
            <span style={{
              padding: '3px 10px', fontSize: 11, borderRadius: 999,
              color: settled ? '#7EAA6E' : '#0F0F10',
              background: settled ? 'rgba(126,170,110,0.08)' : 'rgba(15,15,16,0.08)',
              textAlign: 'center',
            }}>{settled ? 'Repaid' : (isPartial(d) ? 'Partial' : 'Open')}</span>
          </div>
        );
      })}

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
                    border: `1px solid ${form.direction === opt.id ? '#0F0F10' : '#D5D1C4'}`,
                    color: form.direction === opt.id ? '#0F0F10' : '#4B5563',
                    background: form.direction === opt.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {opt.icon}{opt.label}
                </button>
              ))}
            </div>
          </div>

          <SearchSelect
            label="LINK CUSTOMER (optional)"
            placeholder="Search customers..."
            options={customers.map(c => ({ id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone }))}
            value={form.customerId}
            onChange={id => setForm(f => ({ ...f, customerId: id }))}
          />

          <Input label="COUNTERPARTY NAME"
            placeholder="If not a customer, type a name here"
            value={form.counterparty}
            onChange={e => setForm(f => ({ ...f, counterparty: e.target.value }))} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="AMOUNT (BHD)" type="number" step="0.001"
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            <Input label="DUE DATE (optional)" type="date"
              value={form.dueDate}
              onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
          </div>

          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>{form.direction === 'we_lend' ? 'PAID FROM' : 'RECEIVED INTO'}</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {(['cash', 'bank'] as CashSource[]).map(s => (
                <button key={s} onClick={() => setForm(f => ({ ...f, source: s }))}
                  className="cursor-pointer rounded flex items-center gap-2" style={{
                    padding: '8px 18px', fontSize: 12,
                    border: `1px solid ${form.source === s ? '#0F0F10' : '#D5D1C4'}`,
                    color: form.source === s ? '#0F0F10' : '#6B7280',
                    background: form.source === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {s === 'cash' ? <Wallet size={12} /> : <Building2 size={12} />}
                  {s === 'cash' ? 'Cash' : 'Bank'}
                </button>
              ))}
            </div>
          </div>

          <Input label="NOTES (optional)"
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />

          <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E1D6' }}>
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
            <div style={{ padding: '14px 18px', background: '#EFECE2', borderRadius: 10, border: '1px solid #E5E1D6' }}>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>Original amount</span>
                <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(detail.amount)} BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>Paid so far</span>
                <span className="font-mono" style={{ color: '#7EAA6E' }}>{fmt(detail.paidAmount)} BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 13, paddingTop: 6, borderTop: '1px solid #E5E1D6', marginTop: 6 }}>
                <span style={{ color: '#0F0F10' }}>Remaining</span>
                <span className="font-mono" style={{ color: isSettled(detail) ? '#7EAA6E' : '#AA6E6E' }}>{fmt(detailRemaining)} BHD</span>
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
                <div key={p.id} className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E1D6', fontSize: 12 }}>
                  <div className="flex items-center gap-2">
                    {p.source === 'cash' ? <Wallet size={12} style={{ color: '#4B5563' }} /> : <Building2 size={12} style={{ color: '#4B5563' }} />}
                    <span style={{ color: '#4B5563' }}>{fmtDate(p.paidAt)}</span>
                    {p.notes && <span style={{ color: '#6B7280' }}>· {p.notes}</span>}
                  </div>
                  <span className="font-mono" style={{ color: '#7EAA6E' }}>{fmt(p.amount)} BHD</span>
                </div>
              ))}
            </div>

            {/* Record payment form */}
            {!isSettled(detail) && (
              <div style={{ padding: '14px 18px', border: '1px solid #D5D1C4', borderRadius: 10 }}>
                <span className="text-overline" style={{ marginBottom: 10 }}>RECORD REPAYMENT</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                  <Input label="AMOUNT (BHD)" type="number" step="0.001"
                    value={payAmount}
                    onChange={e => setPayAmount(e.target.value)} />
                  <Input label="DATE" type="date"
                    value={payDate}
                    onChange={e => setPayDate(e.target.value)} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <span className="text-overline" style={{ marginBottom: 6 }}>{detail.direction === 'we_lend' ? 'RECEIVED INTO' : 'PAID FROM'}</span>
                  <div className="flex gap-2" style={{ marginTop: 8 }}>
                    {(['cash', 'bank'] as CashSource[]).map(s => (
                      <button key={s} onClick={() => setPaySource(s)}
                        className="cursor-pointer rounded flex items-center gap-2" style={{
                          padding: '6px 14px', fontSize: 12,
                          border: `1px solid ${paySource === s ? '#0F0F10' : '#D5D1C4'}`,
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

            <div className="flex justify-between" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
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
              <div style={{ padding: '14px 18px', border: '1px solid #D5D1C4', borderRadius: 10, marginTop: 12 }}>
                <span className="text-overline" style={{ marginBottom: 10 }}>EDIT DEBT</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  <Input label="COUNTERPARTY" value={editForm.counterparty}
                    onChange={e => setEditForm({ ...editForm, counterparty: e.target.value })} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <Input label="AMOUNT (BHD)" type="number" step="0.001" value={editForm.amount}
                      onChange={e => setEditForm({ ...editForm, amount: e.target.value })} />
                    <Input label="DUE DATE" type="date" value={editForm.dueDate}
                      onChange={e => setEditForm({ ...editForm, dueDate: e.target.value })} />
                  </div>
                  <div>
                    <span className="text-overline" style={{ marginBottom: 6 }}>SOURCE</span>
                    <div className="flex gap-2" style={{ marginTop: 6 }}>
                      {(['cash', 'bank'] as CashSource[]).map(s => (
                        <button key={s} onClick={() => setEditForm({ ...editForm, source: s })}
                          className="cursor-pointer rounded"
                          style={{ padding: '6px 14px', fontSize: 12,
                            border: `1px solid ${editForm.source === s ? '#0F0F10' : '#D5D1C4'}`,
                            color: editForm.source === s ? '#0F0F10' : '#6B7280',
                            background: editForm.source === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                          }}>{s === 'cash' ? 'Cash' : 'Bank'}</button>
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
