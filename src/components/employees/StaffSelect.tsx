import { useEffect, useMemo } from 'react';
import { useEmployeeStore } from '@/stores/employeeStore';

interface StaffSelectProps {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  helper?: string;
  required?: boolean;
}

// Wave-2/4: Einheitlicher Staff-Picker fuer alle Domain-Module.
// Filtert auf aktive Mitarbeiter (employmentStatus !== 'inactive').
export function StaffSelect({ value, onChange, label = 'STAFF', helper, required = false }: StaffSelectProps) {
  const { employees, loadEmployees } = useEmployeeStore();
  useEffect(() => { loadEmployees(); }, [loadEmployees]);
  const active = useMemo(() => employees.filter(e => e.employmentStatus !== 'inactive'), [employees]);

  return (
    <div>
      <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
        {label}{required ? ' *' : ''}
      </span>
      {active.length === 0 ? (
        <div style={{
          padding: '10px 12px', borderRadius: 6,
          border: '1px solid #E5E9EE', background: '#FAFAFA',
          fontSize: 12, color: '#6B7280',
        }}>
          No active employees. <a href="/employees" style={{ color: '#3D7FFF' }}>Add one</a> to assign.
        </div>
      ) : (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{
            width: '100%', padding: '10px 12px', fontSize: 13,
            border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF', color: '#0F0F10',
          }}
        >
          <option value="">— Unassigned —</option>
          {active.map(emp => (
            <option key={emp.id} value={emp.id}>
              {emp.name}{emp.role ? ` · ${emp.role}` : ''}
            </option>
          ))}
        </select>
      )}
      {helper && (
        <span style={{ display: 'block', marginTop: 6, fontSize: 11, color: '#6B7280' }}>{helper}</span>
      )}
    </div>
  );
}

// Helper: Resolve employee name (optional component-less use, e.g. in detail pages).
export function useStaffName(employeeId?: string): string {
  const { employees } = useEmployeeStore();
  if (!employeeId) return '';
  const e = employees.find(x => x.id === employeeId);
  return e ? `${e.name}${e.role ? ` · ${e.role}` : ''}` : '';
}
