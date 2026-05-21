// Plan §Expenses + §Pay-Later — List + create modal mit Pay-Now/Later/Partial + Record-Payment
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Wallet, Trash2, CreditCard, Repeat, Pause, Play, ChevronDown, ChevronUp } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useExpenseStore } from '@/stores/expenseStore';
import { useRecurringExpenseStore } from '@/stores/recurringExpenseStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import type { Expense, ExpenseCategory, RecurringExpenseTemplate } from '@/core/models/types';
import { matchesDeep } from '@/core/utils/deep-search';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
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
  const {
    templates: recurringTemplates,
    loadTemplates: loadRecurringTemplates,
    createTemplate: createRecurringTemplate,
    updateTemplate: updateRecurringTemplate,
    setActive: setRecurringActive,
    deleteTemplate: deleteRecurringTemplate,
    runDueGenerator: runRecurringGenerator,
  } = useRecurringExpenseStore();
  const { employees, loadEmployees } = useEmployeeStore();
  const activeEmployees = useMemo(
    () => employees.filter(e => e.employmentStatus !== 'inactive'),
    [employees]
  );
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

  // Recurring-Form-State.
  // dayOfMonth wird primaer aus form.expenseDate abgeleitet (nicht hardcoded auf 1).
  // User kann den Day-Wert nachtraeglich ueberschreiben — manuelle Aenderung wird via
  // recurringDayOverridden festgehalten, damit nachfolgende Date-Aenderungen nicht
  // wieder ueberschreiben.
  const [recurringEnabled, setRecurringEnabled] = useState(false);
  const [recurringDayOfMonth, setRecurringDayOfMonth] = useState<number>(1);
  const [recurringDayOverridden, setRecurringDayOverridden] = useState(false);
  const [recurringEndDate, setRecurringEndDate] = useState<string>('');
  const [templatesExpanded, setTemplatesExpanded] = useState(true);
  const [editTemplateId, setEditTemplateId] = useState<string | null>(null);
  const [editTemplateForm, setEditTemplateForm] = useState<Partial<RecurringExpenseTemplate>>({});

  // v0.4.6 — Direkt-Sprung: der Dashboard-Button "Add Expense" navigiert mit
  // ?new=1 hierher und oeffnet sofort das New-Expense-Modal.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowNew(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const [confirmDeleteTemplate, setConfirmDeleteTemplate] = useState<string | null>(null);

  // Record-Payment-Modal-State
  const [payExpenseId, setPayExpenseId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState<number>(0);
  const [payMethod, setPayMethod] = useState<'cash' | 'bank' | 'benefit'>('bank');

  useEffect(() => {
    loadExpenses();
    loadRecurringTemplates();
    loadEmployees();
    // Generator on mount — falls App noch nicht gelaufen ist seit dem 1.
    try { runRecurringGenerator(); } catch { /* ignore */ }
  }, [loadExpenses, loadRecurringTemplates, loadEmployees, runRecurringGenerator]);

  // Tag aus form.expenseDate ableiten und in recurringDayOfMonth spiegeln —
  // ausser User hat den Day-Wert manuell ueberschrieben. Greift wenn Recurring
  // erst aktiviert wird ODER wenn das Datum geaendert wird.
  useEffect(() => {
    if (!recurringEnabled) return;
    if (recurringDayOverridden) return;
    const iso = form.expenseDate;
    if (!iso) return;
    const day = parseInt(iso.split('-')[2] || '0', 10);
    if (day >= 1 && day <= 31) setRecurringDayOfMonth(day);
  }, [recurringEnabled, recurringDayOverridden, form.expenseDate]);

  // Salary-Auto-Prefill: bei Wahl eines Employee die base_salary ins Amount-Feld
  // uebernehmen, wenn Amount noch leer/0 ist. employeeId wird zurueckgesetzt
  // wenn category != 'Salary' (sonst stehen bleiben würde Daten-Bug bei Switches).
  useEffect(() => {
    if (form.category !== 'Salary' && form.employeeId) {
      setForm(f => ({ ...f, employeeId: undefined }));
    }
  }, [form.category]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!form.employeeId) return;
    const emp = activeEmployees.find(e => e.id === form.employeeId);
    if (emp && emp.baseSalary != null && (!form.amount || form.amount <= 0)) {
      setForm(f => ({ ...f, amount: emp.baseSalary }));
    }
  }, [form.employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    try {
      if (form.category === 'Salary' && !form.employeeId) {
        alert('Salary expenses require an employee. Pick one or change the category.');
        return;
      }
      if (recurringEnabled) {
        // Recurring: nur Template anlegen — Generator erzeugt direkt die erste
        // Instanz auf dem User-Datum (start_date), danach folgt day_of_month-Regel.
        if (payTiming === 'partial') {
          alert('Partial payment is not available for recurring expenses — choose Pay now or Pay later.');
          return;
        }
        const startDate = form.expenseDate || new Date().toISOString().split('T')[0];
        createRecurringTemplate({
          category: form.category || 'Rent',
          amount: form.amount,
          paymentMethod: form.paymentMethod || 'bank',
          payNowDefault: payTiming === 'now',
          description: form.description,
          dayOfMonth: recurringDayOfMonth,
          startDate,
          endDate: recurringEndDate || undefined,
          active: true,
          employeeId: form.employeeId,
        });
      } else {
        const initial = payTiming === 'now' ? form.amount
          : payTiming === 'partial' ? Math.max(0, Math.min(form.amount, partialAmount))
          : 0;
        createExpense({
          category: form.category,
          amount: form.amount,
          paymentMethod: form.paymentMethod || 'bank',
          expenseDate: form.expenseDate || new Date().toISOString().split('T')[0],
          description: form.description,
          payNow: payTiming === 'now',
          initialPaid: initial,
          employeeId: form.employeeId,
        });
      }
      setForm({
        category: 'Rent',
        paymentMethod: 'bank',
        expenseDate: new Date().toISOString().split('T')[0],
      });
      setPayTiming('now');
      setPartialAmount(0);
      setRecurringEnabled(false);
      setRecurringDayOfMonth(1);
      setRecurringDayOverridden(false);
      setRecurringEndDate('');
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
              <Bhd v={totals[c.value] || 0}/>
            </div>
            <span style={{ fontSize: 10, color: '#6B7280' }}>BHD</span>
          </div>
        ))}
      </div>

      {/* Recurring Templates Section */}
      {recurringTemplates.length > 0 && (
        <Card noPadding style={{ marginBottom: 24 }}>
          <div
            className="cursor-pointer"
            onClick={() => setTemplatesExpanded(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderBottom: templatesExpanded ? '1px solid #E5E9EE' : 'none',
            }}
          >
            <div className="flex items-center gap-2">
              <Repeat size={14} style={{ color: '#715DE3' }} />
              <span style={{ fontSize: 13, fontWeight: 500, color: '#0F0F10' }}>Recurring expenses</span>
              <span style={{ fontSize: 11, color: '#6B7280' }}>
                · {recurringTemplates.filter(t => t.active).length} active · {recurringTemplates.filter(t => !t.active).length} paused
              </span>
            </div>
            {templatesExpanded ? <ChevronUp size={14} style={{ color: '#6B7280' }} /> : <ChevronDown size={14} style={{ color: '#6B7280' }} />}
          </div>

          {templatesExpanded && (
            <div>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.7fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['CATEGORY', 'AMOUNT', 'DESCRIPTION', 'SCHEDULE', 'PAY MODE', 'STATUS', ''].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {recurringTemplates.map(t => (
                <div key={t.id} style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,0.9fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.7fr)',
                  gap: 12, padding: '12px 16px', alignItems: 'center',
                  borderBottom: '1px solid rgba(229,225,214,0.6)',
                  opacity: t.active ? 1 : 0.55,
                }}>
                  <span style={{ fontSize: 13, color: '#0F0F10' }}>
                    {CATEGORIES.find(c => c.value === t.category)?.label || t.category}
                    {t.employeeId && (
                      <span style={{ display: 'block', fontSize: 10, color: '#6B7280' }}>
                        {employees.find(e => e.id === t.employeeId)?.name || '—'}
                      </span>
                    )}
                  </span>
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={t.amount}/></span>
                  <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.description || '—'}
                  </span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>
                    Day {t.dayOfMonth} · monthly
                    {t.endDate && <div style={{ fontSize: 10, color: '#9CA3AF' }}>until {t.endDate}</div>}
                  </span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>
                    {t.payNowDefault ? `Pay now · ${t.paymentMethod}` : 'Payable'}
                  </span>
                  <span style={{
                    padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                    color: t.active ? '#16A34A' : '#6B7280',
                    background: t.active ? 'rgba(22,163,74,0.10)' : 'rgba(107,114,128,0.10)',
                    border: `1px solid ${t.active ? 'rgba(22,163,74,0.30)' : 'rgba(107,114,128,0.30)'}`,
                    width: 'fit-content',
                  }}>{t.active ? 'Active' : 'Paused'}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setRecurringActive(t.id, !t.active)}
                      title={t.active ? 'Pause' : 'Resume'}
                      className="cursor-pointer"
                      style={{
                        padding: '4px 6px', fontSize: 11, border: '1px solid #D5D9DE',
                        color: t.active ? '#FF8730' : '#16A34A', borderRadius: 4, background: 'none',
                      }}
                    >
                      {t.active ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <button
                      onClick={() => { setEditTemplateId(t.id); setEditTemplateForm({ ...t }); }}
                      title="Edit"
                      className="cursor-pointer"
                      style={{
                        padding: '4px 8px', fontSize: 10, border: '1px solid #D5D9DE',
                        color: '#4B5563', borderRadius: 4, background: 'none',
                      }}>Edit</button>
                    <button
                      onClick={() => setConfirmDeleteTemplate(t.id)}
                      title="Delete template"
                      className="cursor-pointer"
                      style={{ background: 'none', border: 'none', color: '#6B7280' }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

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
                <span className="font-mono flex items-center gap-1" style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.recurringTemplateId && <Repeat size={10} style={{ color: '#715DE3', flexShrink: 0 }} />}
                  {e.expenseNumber}
                </span>
                <span style={{ fontSize: 12, color: '#4B5563' }}>{e.expenseDate}</span>
                <span style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{CATEGORIES.find(c => c.value === e.category)?.label || e.category}</span>
                <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || '—'}</span>
                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={e.amount}/></span>
                <span className="font-mono" style={{ fontSize: 13, color: e.paidAmount > 0 ? '#16A34A' : '#9CA3AF' }}><Bhd v={e.paidAmount || 0}/></span>
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
                {(['cash', 'bank', 'benefit'] as const).map(m => {
                  const active = form.paymentMethod === m;
                  return (
                    <button key={m} onClick={() => setForm({ ...form, paymentMethod: m })}
                      className="cursor-pointer rounded"
                      style={{
                        padding: '8px 16px', fontSize: 13,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}</button>
                  );
                })}
              </div>
            </div>
          )}

          <Input label="DESCRIPTION" placeholder="e.g. April office rent"
            value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} />

          {form.category === 'Salary' && (
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>EMPLOYEE *</span>
              {activeEmployees.length === 0 ? (
                <div style={{
                  padding: '10px 12px', borderRadius: 6,
                  border: '1px solid rgba(220,38,38,0.30)',
                  background: 'rgba(220,38,38,0.06)',
                  fontSize: 12, color: '#0F0F10',
                }}>
                  No active employees yet. <a href="/employees" style={{ color: '#3D7FFF' }}>Add an employee</a> first.
                </div>
              ) : (
                <select
                  value={form.employeeId || ''}
                  onChange={e => setForm({ ...form, employeeId: e.target.value || undefined })}
                  style={{
                    width: '100%', padding: '10px 12px', fontSize: 13,
                    border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF', color: '#0F0F10',
                  }}
                >
                  <option value="">— Select employee —</option>
                  {activeEmployees.map(emp => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}{emp.role ? ` · ${emp.role}` : ''}{emp.baseSalary != null ? ` · ${fmt(emp.baseSalary)} BHD` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Recurring Section */}
          <div style={{
            padding: '12px 14px', borderRadius: 8,
            border: `1px solid ${recurringEnabled ? 'rgba(113,93,227,0.40)' : '#E5E9EE'}`,
            background: recurringEnabled ? 'rgba(113,93,227,0.04)' : 'transparent',
          }}>
            <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 13, color: '#0F0F10' }}>
              <input
                type="checkbox"
                checked={recurringEnabled}
                onChange={e => setRecurringEnabled(e.target.checked)}
                style={{ accentColor: '#715DE3' }}
              />
              <Repeat size={13} style={{ color: '#715DE3' }} />
              Repeat monthly
              <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 4 }}>
                (e.g. rent, salary, utilities)
              </span>
            </label>

            {recurringEnabled && (
              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Input
                  label="DAY OF MONTH (FOLLOWING MONTHS)" type="number" min="1" max="31"
                  value={recurringDayOfMonth || 1}
                  onChange={e => {
                    const v = Math.max(1, Math.min(31, parseInt(e.target.value) || 1));
                    setRecurringDayOfMonth(v);
                    setRecurringDayOverridden(true);
                  }}
                />
                <Input
                  label="END DATE (OPTIONAL)" type="date"
                  value={recurringEndDate}
                  onChange={e => setRecurringEndDate(e.target.value)}
                />
                <span style={{ gridColumn: '1 / -1', fontSize: 11, color: '#6B7280' }}>
                  First instance uses the <strong>Date</strong> above ({form.expenseDate || 'today'}).
                  Following months land on day {recurringDayOfMonth} (clamped if month is shorter — Feb 31 → 28/29).
                  Each month creates a new expense, {payTiming === 'now' ? 'paid immediately' : 'as a payable'}.
                </span>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!form.amount || form.amount <= 0}>
              {recurringEnabled ? 'Create Recurring' : 'Create Expense'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Recurring Template Modal */}
      <Modal open={!!editTemplateId} onClose={() => setEditTemplateId(null)} title="Edit Recurring Template" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CATEGORY</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 6 }}>
              {CATEGORIES.map(c => (
                <button key={c.value} onClick={() => setEditTemplateForm({ ...editTemplateForm, category: c.value })}
                  className="cursor-pointer rounded"
                  style={{
                    padding: '6px 12px', fontSize: 12,
                    border: `1px solid ${editTemplateForm.category === c.value ? '#0F0F10' : '#D5D9DE'}`,
                    color: editTemplateForm.category === c.value ? '#0F0F10' : '#6B7280',
                    background: editTemplateForm.category === c.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{c.label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="AMOUNT (BHD)" type="number" step="0.01"
              value={editTemplateForm.amount ?? ''}
              onChange={e => setEditTemplateForm({ ...editTemplateForm, amount: parseFloat(e.target.value) || 0 })} />
            <Input label="DAY OF MONTH" type="number" min="1" max="31"
              value={editTemplateForm.dayOfMonth ?? 1}
              onChange={e => setEditTemplateForm({ ...editTemplateForm, dayOfMonth: Math.max(1, Math.min(31, parseInt(e.target.value) || 1)) })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="START DATE" type="date"
              value={editTemplateForm.startDate || ''}
              onChange={e => setEditTemplateForm({ ...editTemplateForm, startDate: e.target.value })} />
            <Input label="END DATE (OPTIONAL)" type="date"
              value={editTemplateForm.endDate || ''}
              onChange={e => setEditTemplateForm({ ...editTemplateForm, endDate: e.target.value })} />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAY MODE</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {([
                { v: true,  label: 'Pay now (auto)' },
                { v: false, label: 'Pay later (Payable)' },
              ] as const).map(opt => {
                const active = (editTemplateForm.payNowDefault ?? false) === opt.v;
                return (
                  <button key={String(opt.v)} onClick={() => setEditTemplateForm({ ...editTemplateForm, payNowDefault: opt.v })}
                    className="cursor-pointer rounded"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{opt.label}</button>
                );
              })}
            </div>
          </div>
          {editTemplateForm.payNowDefault && (
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAID FROM</span>
              <div className="flex gap-2" style={{ marginTop: 6 }}>
                {(['cash', 'bank', 'benefit'] as const).map(m => {
                  const active = editTemplateForm.paymentMethod === m;
                  return (
                    <button key={m} onClick={() => setEditTemplateForm({ ...editTemplateForm, paymentMethod: m })}
                      className="cursor-pointer rounded"
                      style={{
                        padding: '8px 16px', fontSize: 13,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}</button>
                  );
                })}
              </div>
            </div>
          )}
          <Input label="DESCRIPTION"
            value={editTemplateForm.description || ''}
            onChange={e => setEditTemplateForm({ ...editTemplateForm, description: e.target.value })} />
          {editTemplateForm.category === 'Salary' && (
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>EMPLOYEE *</span>
              <select
                value={editTemplateForm.employeeId || ''}
                onChange={e => setEditTemplateForm({ ...editTemplateForm, employeeId: e.target.value || undefined })}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 13,
                  border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF', color: '#0F0F10',
                }}
              >
                <option value="">— Select employee —</option>
                {activeEmployees.map(emp => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}{emp.role ? ` · ${emp.role}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <span style={{ fontSize: 11, color: '#6B7280' }}>
            Changes apply only to <strong>future</strong> instances. Existing expenses already created stay as-is.
          </span>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setEditTemplateId(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              if (!editTemplateId) return;
              if (editTemplateForm.category === 'Salary' && !editTemplateForm.employeeId) {
                alert('Salary templates require an employee.');
                return;
              }
              updateRecurringTemplate(editTemplateId, editTemplateForm);
              setEditTemplateId(null);
            }}>Save Changes</Button>
          </div>
        </div>
      </Modal>

      {/* Delete Template Confirmation */}
      <Modal open={!!confirmDeleteTemplate} onClose={() => setConfirmDeleteTemplate(null)} title="Delete recurring template?" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 13, color: '#4B5563', margin: 0 }}>
            The template will stop generating new monthly expenses. Already-created expenses remain unchanged.
          </p>
          <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>
            Tip: if it's just a temporary stop, use <strong>Pause</strong> instead — keeps the schedule and lets you resume later.
          </p>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setConfirmDeleteTemplate(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              if (confirmDeleteTemplate) deleteRecurringTemplate(confirmDeleteTemplate);
              setConfirmDeleteTemplate(null);
            }} style={{ background: '#DC2626' }}>Delete Template</Button>
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
              <div className="flex justify-between"><span>Paid:</span><span className="font-mono" style={{ color: '#16A34A' }}><Bhd v={editForm.paidAmount || 0}/> BHD</span></div>
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
                <div className="flex justify-between" style={{ marginTop: 4 }}><span>Total:</span><span className="font-mono"><Bhd v={exp.amount}/> BHD</span></div>
                <div className="flex justify-between" style={{ marginTop: 4 }}><span>Already paid:</span><span className="font-mono" style={{ color: '#16A34A' }}><Bhd v={exp.paidAmount || 0}/> BHD</span></div>
                <div className="flex justify-between" style={{ marginTop: 4 }}><span>Remaining:</span><span className="font-mono" style={{ color: '#DC2626' }}><Bhd v={remaining}/> BHD</span></div>
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
