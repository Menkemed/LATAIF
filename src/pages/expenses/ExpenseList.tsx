// Plan §Expenses + §Pay-Later — List + create modal mit Pay-Now/Later/Partial + Record-Payment
import { useEffect, useMemo, useState } from 'react';
import { Wallet, Trash2, CreditCard } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useExpenseStore } from '@/stores/expenseStore';
import type { Expense, ExpenseCategory } from '@/core/models/types';
import { matchesDeep } from '@/core/utils/deep-search';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

const CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'Rent',         label: 'Rent' },
  { value: 'Salary',       label: 'Salary' },
  { value: 'Utilities',    label: 'Utilities' },
  { value: 'CardFees',     label: 'Card Fees' },
  { value: 'RepairCosts',  label: 'Repair Costs' },
  { value: 'Transport',    label: 'Transport' },
  { value: 'Miscellaneous', label: 'Miscellaneous' },
];

type PayTiming = 'now' | 'later' | 'partial';
type DisplayStatus = 'Paid' | 'Partially Paid' | 'Unpaid' | 'Cancelled';

function deriveDisplayStatus(e: Expense): DisplayStatus {
  if (e.status === 'CANCELLED') return 'Cancelled';
  const paid = e.paidAmount || 0;
  if (paid >= e.amount - 0.005) return 'Paid';
  if (paid > 0.005) return 'Partially Paid';
  return 'Unpaid';
}

const STATUS_STYLE: Record<DisplayStatus, { fg: string; bg: string }> = {
  'Paid':            { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
  'Partially Paid':  { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)' },
  'Unpaid':          { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  'Cancelled':       { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)' },
};

export function ExpenseList() {
  const { expenses, loadExpenses, createExpense, updateExpense, deleteExpense, recordExpensePayment, getTotalsByCategory } = useExpenseStore();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | ''>('');
  const [showNew, setShowNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Expense>>({});
  const [form, setForm] = useState<Partial<Expense>>({
    category: 'Rent',
    paymentMethod: 'bank',
    expenseDate: new Date().toISOString().split('T')[0],
  });
  const [payTiming, setPayTiming] = useState<PayTiming>('now');
  const [partialAmount, setPartialAmount] = useState<number>(0);

  // Record-Payment-Modal-State
  const [payExpenseId, setPayExpenseId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState<number>(0);
  const [payMethod, setPayMethod] = useState<'cash' | 'bank'>('bank');

  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  const filtered = useMemo(() => {
    let r = expenses;
    if (categoryFilter) r = r.filter(e => e.category === categoryFilter);
    if (search) r = r.filter(e => matchesDeep(e, search));
    return r;
  }, [expenses, search, categoryFilter]);

  const totals = getTotalsByCategory();
  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);
  const totalPaid = expenses.filter(e => e.status !== 'CANCELLED').reduce((s, e) => s + (e.paidAmount || 0), 0);
  const totalUnpaid = expenses.filter(e => e.status !== 'CANCELLED')
    .reduce((s, e) => s + Math.max(0, e.amount - (e.paidAmount || 0)), 0);

  function handleCreate() {
    if (!form.amount || form.amount <= 0) return;
    const initial = payTiming === 'now' ? form.amount
      : payTiming === 'partial' ? Math.max(0, Math.min(form.amount, partialAmount))
      : 0;
    try {
      createExpense({
        category: form.category,
        amount: form.amount,
        paymentMethod: form.paymentMethod || 'bank',
        expenseDate: form.expenseDate || new Date().toISOString().split('T')[0],
        description: form.description,
        payNow: payTiming === 'now',
        initialPaid: initial,
      });
      setForm({
        category: 'Rent',
        paymentMethod: 'bank',
        expenseDate: new Date().toISOString().split('T')[0],
      });
      setPayTiming('now');
      setPartialAmount(0);
      setShowNew(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  function openPaymentModal(expenseId: string) {
    const exp = expenses.find(e => e.id === expenseId);
    if (!exp) return;
    setPayExpenseId(expenseId);
    setPayAmount(Math.max(0, exp.amount - (exp.paidAmount || 0)));
    setPayMethod(exp.paymentMethod || 'bank');
  }

  function handleRecordPayment() {
    if (!payExpenseId || payAmount <= 0) return;
    try {
      recordExpensePayment(payExpenseId, payAmount, payMethod);
      setPayExpenseId(null);
      setPayAmount(0);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <PageLayout
      title="Expenses"
      subtitle={`${expenses.length} records · ${fmt(grandTotal)} total · ${fmt(totalPaid)} paid · ${fmt(totalUnpaid)} open`}
      showSearch onSearch={setSearch} searchPlaceholder="Search description, number, reference..."
      actions={
        <div className="flex gap-2 items-center">
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            <button onClick={() => setCategoryFilter('')}
              className="cursor-pointer transition-all"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 12,
                border: `1px solid ${!categoryFilter ? '#0F0F10' : 'transparent'}`,
                color: !categoryFilter ? '#0F0F10' : '#6B7280',
                background: !categoryFilter ? 'rgba(15,15,16,0.06)' : 'transparent',
              }}>All</button>
            {CATEGORIES.map(c => (
              <button key={c.value} onClick={() => setCategoryFilter(c.value)}
                className="cursor-pointer transition-all"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${categoryFilter === c.value ? '#0F0F10' : 'transparent'}`,
                  color: categoryFilter === c.value ? '#0F0F10' : '#6B7280',
                  background: categoryFilter === c.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}>{c.label}</button>
            ))}
          </div>
          <Button variant="primary" onClick={() => setShowNew(true)}>New Expense</Button>
        </div>
      }
    >
      {/* Category summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12, marginBottom: 24 }}>
        {CATEGORIES.map(c => (
          <div key={c.value} style={{
            padding: '12px 14px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12,
          }}>
            <span className="text-overline">{c.label}</span>
            <div className="font-display" style={{ fontSize: 18, color: '#0F0F10', marginTop: 4 }}>
              {fmt(totals[c.value] || 0)}
            </div>
            <span style={{ fontSize: 10, color: '#6B7280' }}>BHD</span>
          </div>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center' }}>
          <Wallet size={36} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 12px' }} />
          <p style={{ fontSize: 13, color: '#6B7280' }}>
            {search || categoryFilter ? 'No expenses match your filters.' : 'No expenses recorded yet.'}
          </p>
        </div>
      ) : (
        <Card noPadding>
          <div style={{
            display: 'grid', gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,0.5fr)',
            gap: 12, padding: '12px 16px', borderBottom: '1px solid #E5E9EE',
          }}>
            {['NUMBER', 'DATE', 'CATEGORY', 'DESCRIPTION', 'AMOUNT', 'PAID', 'REMAINING', 'STATUS', ''].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          {filtered.map(e => {
            const remaining = Math.max(0, e.amount - (e.paidAmount || 0));
            const displayStatus = deriveDisplayStatus(e);
            const statusStyle = STATUS_STYLE[displayStatus];
            const canPay = displayStatus === 'Unpaid' || displayStatus === 'Partially Paid';
            return (
              <div key={e.id} className="cursor-pointer transition-colors" style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.1fr) minmax(0,0.5fr)',
                gap: 12, padding: '12px 16px', alignItems: 'center',
                borderBottom: '1px solid rgba(229,225,214,0.6)',
              }}
              onClick={() => { setEditId(e.id); setEditForm({ ...e }); }}
              onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
              onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.expenseNumber}</span>
                <span style={{ fontSize: 12, color: '#4B5563' }}>{e.expenseDate}</span>
                <span style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{CATEGORIES.find(c => c.value === e.category)?.label || e.category}</span>
                <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || '—'}</span>
                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(e.amount)}</span>
                <span className="font-mono" style={{ fontSize: 13, color: e.paidAmount > 0 ? '#16A34A' : '#9CA3AF' }}>{fmt(e.paidAmount || 0)}</span>
                <span className="font-mono" style={{ fontSize: 13, color: remaining > 0.005 ? '#DC2626' : '#9CA3AF' }}>
                  {remaining > 0.005 ? fmt(remaining) : '—'}
                </span>
                <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
                  <span style={{
                    padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                    color: statusStyle.fg, background: statusStyle.bg,
                    border: `1px solid ${statusStyle.fg}33`, whiteSpace: 'nowrap',
                  }}>{displayStatus}</span>
                  {canPay && (
                    <button onClick={(ev) => { ev.stopPropagation(); openPaymentModal(e.id); }}
                      title="Record payment"
                      className="cursor-pointer" style={{
                        padding: '3px 6px', fontSize: 10, border: '1px solid #16A34A',
                        color: '#16A34A', borderRadius: 4, background: 'none',
                      }}><CreditCard size={11} /></button>
                  )}
                </div>
                <button onClick={(ev) => { ev.stopPropagation(); setConfirmDelete(e.id); }} className="cursor-pointer"
                  style={{ background: 'none', border: 'none', color: '#6B7280' }}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </Card>
      )}

      {/* New Expense Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Expense" width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CATEGORY</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 6 }}>
              {CATEGORIES.map(c => (
                <button key={c.value} onClick={() => setForm({ ...form, category: c.value })}
                  className="cursor-pointer rounded"
                  style={{
                    padding: '6px 12px', fontSize: 12,
                    border: `1px solid ${form.category === c.value ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.category === c.value ? '#0F0F10' : '#6B7280',
                    background: form.category === c.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{c.label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Input required label="AMOUNT (BHD)" type="number" step="0.01" placeholder="0.00"
              value={form.amount ?? ''} onChange={e => setForm({ ...form, amount: parseFloat(e.target.value) || 0 })} />
            <Input required label="DATE" type="date" value={form.expenseDate || ''} onChange={e => setForm({ ...form, expenseDate: e.target.value })} />
          </div>

          {/* Pay-Timing */}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAYMENT TIMING</span>
            <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              {(['now', 'later', 'partial'] as const).map(t => {
                const active = payTiming === t;
                const label = t === 'now' ? 'Pay now (full)' : t === 'later' ? 'Pay later' : 'Partial payment';
                return (
                  <button key={t} onClick={() => setPayTiming(t)}
                    className="cursor-pointer rounded"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{label}</button>
                );
              })}
            </div>
            {payTiming === 'partial' && (
              <div style={{ marginTop: 10 }}>
                <Input label="PAID NOW (BHD)" type="number" step="0.01" placeholder="0.00"
                  value={partialAmount || ''} onChange={e => setPartialAmount(parseFloat(e.target.value) || 0)} />
                <span style={{ fontSize: 11, color: '#6B7280', marginTop: 4, display: 'block' }}>
                  Remaining will be tracked as open in /payables until fully paid.
                </span>
              </div>
            )}
            {payTiming === 'later' && (
              <span style={{ fontSize: 11, color: '#FF8730', marginTop: 6, display: 'block' }}>
                ⚠ Wird als Unpaid in /payables erscheinen bis bezahlt.
              </span>
            )}
          </div>

          {payTiming !== 'later' && (
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAID FROM</span>
              <div className="flex gap-2" style={{ marginTop: 6 }}>
                {(['cash', 'bank'] as const).map(m => {
                  const active = form.paymentMethod === m;
                  return (
                    <button key={m} onClick={() => setForm({ ...form, paymentMethod: m })}
                      className="cursor-pointer rounded"
                      style={{
                        padding: '8px 16px', fontSize: 13,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
                  );
                })}
              </div>
            </div>
          )}

          <Input label="DESCRIPTION" placeholder="e.g. April office rent"
            value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!form.amount || form.amount <= 0}>Create Expense</Button>
          </div>
        </div>
      </Modal>

      {/* Edit Expense Modal */}
      <Modal open={!!editId} onClose={() => setEditId(null)} title="Edit Expense" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CATEGORY</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 6 }}>
              {CATEGORIES.map(c => (
                <button key={c.value} onClick={() => setEditForm({ ...editForm, category: c.value })}
                  className="cursor-pointer rounded"
                  style={{
                    padding: '6px 12px', fontSize: 12,
                    border: `1px solid ${editForm.category === c.value ? '#0F0F10' : '#D5D9DE'}`,
                    color: editForm.category === c.value ? '#0F0F10' : '#6B7280',
                    background: editForm.category === c.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{c.label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Input required label="AMOUNT (BHD)" type="number" step="0.01"
              value={editForm.amount ?? ''} onChange={e => setEditForm({ ...editForm, amount: parseFloat(e.target.value) || 0 })} />
            <Input required label="DATE" type="date" value={editForm.expenseDate || ''} onChange={e => setEditForm({ ...editForm, expenseDate: e.target.value })} />
          </div>
          {editForm.id && (
            <div style={{ padding: '10px 12px', background: '#F2F7FA', borderRadius: 8, fontSize: 12, color: '#4B5563' }}>
              <div className="flex justify-between"><span>Paid:</span><span className="font-mono" style={{ color: '#16A34A' }}>{fmt(editForm.paidAmount || 0)} BHD</span></div>
              <div className="flex justify-between" style={{ marginTop: 4 }}><span>Remaining:</span><span className="font-mono" style={{ color: '#DC2626' }}>{fmt(Math.max(0, (editForm.amount || 0) - (editForm.paidAmount || 0)))} BHD</span></div>
            </div>
          )}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAID FROM</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['cash', 'bank'] as const).map(m => {
                const active = editForm.paymentMethod === m;
                return (
                  <button key={m} onClick={() => setEditForm({ ...editForm, paymentMethod: m })}
                    className="cursor-pointer rounded"
                    style={{
                      padding: '8px 16px', fontSize: 13,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
                );
              })}
            </div>
          </div>
          <Input label="DESCRIPTION"
            value={editForm.description || ''} onChange={e => setEditForm({ ...editForm, description: e.target.value })} />
          <div className="flex justify-between gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="danger" onClick={() => {
              if (editId && window.confirm('Delete this expense?')) {
                deleteExpense(editId);
                setEditId(null);
              }
            }}>Delete</Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => {
                if (!editId) return;
                try {
                  updateExpense(editId, editForm);
                  setEditId(null);
                } catch (e) {
                  alert(e instanceof Error ? e.message : String(e));
                }
              }}>Save</Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Record Payment Modal */}
      <Modal open={!!payExpenseId} onClose={() => setPayExpenseId(null)} title="Record Expense Payment" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(() => {
            const exp = expenses.find(e => e.id === payExpenseId);
            if (!exp) return null;
            const remaining = Math.max(0, exp.amount - (exp.paidAmount || 0));
            return (
              <div style={{ padding: '10px 12px', background: '#F2F7FA', borderRadius: 8, fontSize: 12, color: '#4B5563' }}>
                <div className="flex justify-between"><span>Expense:</span><span className="font-mono" style={{ color: '#0F0F10' }}>{exp.expenseNumber}</span></div>
                <div className="flex justify-between" style={{ marginTop: 4 }}><span>Total:</span><span className="font-mono">{fmt(exp.amount)} BHD</span></div>
                <div className="flex justify-between" style={{ marginTop: 4 }}><span>Already paid:</span><span className="font-mono" style={{ color: '#16A34A' }}>{fmt(exp.paidAmount || 0)} BHD</span></div>
                <div className="flex justify-between" style={{ marginTop: 4 }}><span>Remaining:</span><span className="font-mono" style={{ color: '#DC2626' }}>{fmt(remaining)} BHD</span></div>
              </div>
            );
          })()}
          <Input required label="PAYMENT AMOUNT (BHD)" type="number" step="0.01"
            value={payAmount || ''} onChange={e => setPayAmount(parseFloat(e.target.value) || 0)} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['cash', 'bank'] as const).map(m => {
                const active = payMethod === m;
                return (
                  <button key={m} onClick={() => setPayMethod(m)}
                    className="cursor-pointer rounded"
                    style={{
                      padding: '8px 16px', fontSize: 13,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setPayExpenseId(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleRecordPayment} disabled={payAmount <= 0}>Record Payment</Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Expense" width={380}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete this expense? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { if (confirmDelete) { deleteExpense(confirmDelete); setConfirmDelete(null); } }}>Delete</Button>
        </div>
      </Modal>
    </PageLayout>
  );
}
