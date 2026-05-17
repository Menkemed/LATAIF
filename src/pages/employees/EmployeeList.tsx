import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Trash2, Pause, Play } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { DuplicateWarningBanner } from '@/components/contacts/DuplicateWarningBanner';
import { findSimilarContacts } from '@/core/contacts/duplicate-check';
import { useEmployeeStore } from '@/stores/employeeStore';
import type { Employee, EmploymentStatus } from '@/core/models/types';
import { matchesDeep } from '@/core/utils/deep-search';
import { Bhd } from '@/components/ui/Bhd';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

const STATUS_STYLE: Record<EmploymentStatus, { fg: string; bg: string; label: string }> = {
  'active':    { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)', label: 'Active' },
  'on_leave':  { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', label: 'On Leave' },
  'inactive':  { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Inactive' },
};

export function EmployeeList() {
  const navigate = useNavigate();
  const { employees, loadEmployees, createEmployee, deleteEmployee, setStatus, getSalaryStats } = useEmployeeStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<EmploymentStatus | ''>('');
  const [showNew, setShowNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Employee>>({
    employmentStatus: 'active',
  });

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const filtered = useMemo(() => {
    let r = employees;
    if (statusFilter) r = r.filter(e => e.employmentStatus === statusFilter);
    if (search) r = r.filter(e => matchesDeep(e, search));
    return r;
  }, [employees, search, statusFilter]);

  const totals = useMemo(() => {
    const active = employees.filter(e => e.employmentStatus === 'active').length;
    const onLeave = employees.filter(e => e.employmentStatus === 'on_leave').length;
    const inactive = employees.filter(e => e.employmentStatus === 'inactive').length;
    const totalBase = employees
      .filter(e => e.employmentStatus === 'active')
      .reduce((s, e) => s + (e.baseSalary || 0), 0);
    return { active, onLeave, inactive, totalBase };
  }, [employees]);

  function handleCreate() {
    if (!form.name || !form.name.trim()) return;
    try {
      createEmployee({
        name: form.name.trim(),
        role: form.role,
        employmentStatus: form.employmentStatus || 'active',
        baseSalary: form.baseSalary,
        phone: form.phone,
        email: form.email,
        notes: form.notes,
      });
      setForm({ employmentStatus: 'active' });
      setShowNew(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  // Duplicate-Check live im New-Employee-Modal.
  const employeeDuplicateMatches = useMemo(() => {
    if (!showNew) return [];
    return findSimilarContacts({ name: form.name, phone: form.phone }, employees);
  }, [showNew, form.name, form.phone, employees]);

  function handleDelete() {
    if (!confirmDelete) return;
    try {
      deleteEmployee(confirmDelete);
      setConfirmDelete(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <PageLayout
      title="Employees"
      subtitle={`${employees.length} total · ${totals.active} active · ${totals.onLeave} on leave · ${fmt(totals.totalBase)} BHD monthly base`}
      showSearch onSearch={setSearch} searchPlaceholder="Search name, role, phone, email..."
      actions={
        <div className="flex gap-2 items-center">
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            <button onClick={() => setStatusFilter('')}
              className="cursor-pointer transition-all"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 12,
                border: `1px solid ${!statusFilter ? '#0F0F10' : 'transparent'}`,
                color: !statusFilter ? '#0F0F10' : '#6B7280',
                background: !statusFilter ? 'rgba(15,15,16,0.06)' : 'transparent',
              }}>All</button>
            {(['active', 'on_leave', 'inactive'] as EmploymentStatus[]).map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className="cursor-pointer transition-all"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${statusFilter === s ? '#0F0F10' : 'transparent'}`,
                  color: statusFilter === s ? '#0F0F10' : '#6B7280',
                  background: statusFilter === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}>{STATUS_STYLE[s].label}</button>
            ))}
          </div>
          <Button variant="primary" onClick={() => setShowNew(true)}>New Employee</Button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <Users size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 12px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {search || statusFilter ? 'No employees match your filters.' : 'No employees yet. Add your first.'}
          </p>
        </div>
      ) : (
        <Card noPadding>
          <div style={{
            display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.8fr) minmax(0,0.8fr)',
            gap: 12, padding: '12px 16px', borderBottom: '1px solid #E5E9EE',
          }}>
            {['NAME', 'ROLE', 'PHONE / EMAIL', 'BASE SALARY', 'PAID THIS YEAR', 'STATUS', ''].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          {filtered.map(e => {
            const stats = getSalaryStats(e.id);
            const style = STATUS_STYLE[e.employmentStatus];
            return (
              <div key={e.id}
                className="cursor-pointer transition-colors"
                onClick={() => navigate(`/employees/${e.id}`)}
                onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.8fr) minmax(0,0.8fr)',
                  gap: 12, padding: '12px 16px', alignItems: 'center',
                  borderBottom: '1px solid rgba(229,225,214,0.6)',
                  opacity: e.employmentStatus === 'inactive' ? 0.55 : 1,
                }}>
                <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                  <div className="flex items-center justify-center rounded-full shrink-0"
                    style={{ width: 32, height: 32, background: '#E5E9EE', border: '1px solid #D5D9DE', fontSize: 11, color: '#4B5563' }}>
                    {(e.name.match(/\b\w/g) || []).slice(0, 2).join('').toUpperCase() || '?'}
                  </div>
                  <span style={{ fontSize: 14, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.name}
                  </span>
                </div>
                <span style={{ fontSize: 13, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.role || '—'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.phone || '—'}</div>
                  <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.email || ''}</div>
                </div>
                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>
                  {e.baseSalary != null ? <Bhd v={e.baseSalary}/> : '—'}
                </span>
                <span className="font-mono" style={{ fontSize: 13, color: stats.totalPaid > 0 ? '#16A34A' : '#9CA3AF' }}>
                  {stats.totalPaid > 0 ? <Bhd v={stats.totalPaid}/> : '—'}
                  {stats.totalOpen > 0.005 && (
                    <span style={{ display: 'block', fontSize: 10, color: '#DC2626' }}><Bhd v={stats.totalOpen}/> open</span>
                  )}
                </span>
                <span style={{
                  padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                  color: style.fg, background: style.bg,
                  border: `1px solid ${style.fg}33`, whiteSpace: 'nowrap', width: 'fit-content',
                }}>{style.label}</span>
                <div className="flex items-center gap-1">
                  {e.employmentStatus === 'active' ? (
                    <button
                      onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, 'on_leave'); }}
                      title="Mark on leave"
                      className="cursor-pointer"
                      style={{ padding: '4px 6px', fontSize: 11, border: '1px solid #D5D9DE', color: '#FF8730', borderRadius: 4, background: 'none' }}>
                      <Pause size={12} />
                    </button>
                  ) : (
                    <button
                      onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, 'active'); }}
                      title="Reactivate"
                      className="cursor-pointer"
                      style={{ padding: '4px 6px', fontSize: 11, border: '1px solid #D5D9DE', color: '#16A34A', borderRadius: 4, background: 'none' }}>
                      <Play size={12} />
                    </button>
                  )}
                  <button onClick={(ev) => { ev.stopPropagation(); setConfirmDelete(e.id); }}
                    className="cursor-pointer"
                    style={{ background: 'none', border: 'none', color: '#6B7280' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* New Employee Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Employee" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {employeeDuplicateMatches.length > 0 && (
            <DuplicateWarningBanner matches={employeeDuplicateMatches} entityLabel="employee" />
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 12 }}>
            <Input required label="NAME" placeholder="e.g. Ahmed Al-Khalifa"
              value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
            <Input label="ROLE" placeholder="e.g. Sales / Repair Tech"
              value={form.role || ''} onChange={e => setForm({ ...form, role: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <PhoneInput label="PHONE" value={form.phone || ''} onChange={v => setForm({ ...form, phone: v })} />
            <Input label="EMAIL" placeholder="email@example.com"
              value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <Input label="BASE SALARY (BHD, OPTIONAL)" type="number" step="0.01" placeholder="0.00"
            value={form.baseSalary ?? ''} onChange={e => setForm({ ...form, baseSalary: parseFloat(e.target.value) || undefined })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>STATUS</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['active', 'on_leave', 'inactive'] as EmploymentStatus[]).map(s => {
                const active = form.employmentStatus === s;
                return (
                  <button key={s} onClick={() => setForm({ ...form, employmentStatus: s })}
                    className="cursor-pointer rounded"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{STATUS_STYLE[s].label}</button>
                );
              })}
            </div>
          </div>
          <Input label="NOTES (OPTIONAL)" placeholder="Internal notes"
            value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!form.name || !form.name.trim()}>
              {employeeDuplicateMatches.length > 0 ? 'Create anyway' : 'Create Employee'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete employee?" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 13, color: '#4B5563', margin: 0 }}>
            This permanently removes the employee record. If salary expenses reference this employee, deletion is blocked — mark as <strong>Inactive</strong> instead.
          </p>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleDelete} style={{ background: '#DC2626' }}>Delete</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
