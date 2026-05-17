import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useEmployeeStore } from '@/stores/employeeStore';

// Wave-5b: einheitliche Staff-Filter-Pille fuer Listen-Seiten.
// Nutzt useSearchParams (?staff=<id>) damit Filter URL-driven sind.
// Wenn aktiv: rote Clear-Pille. Wenn inaktiv: dropdown mit "Staff: all".
export function StaffFilterPill() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { employees } = useEmployeeStore();

  const staffFilter = searchParams.get('staff') || '';
  const staffName = useMemo(() => {
    if (!staffFilter) return '';
    return employees.find(e => e.id === staffFilter)?.name || '';
  }, [staffFilter, employees]);

  if (employees.filter(e => e.employmentStatus !== 'inactive').length === 0) {
    return null;
  }

  if (staffFilter) {
    return (
      <button
        onClick={() => {
          const next = new URLSearchParams(searchParams);
          next.delete('staff');
          setSearchParams(next, { replace: true });
        }}
        className="cursor-pointer transition-colors flex items-center gap-1"
        style={{
          padding: '6px 12px', fontSize: 12, borderRadius: 999,
          border: '1px solid #715DE3', background: 'rgba(113,93,227,0.06)', color: '#715DE3',
        }}
      >
        ✕ {staffName || staffFilter}
      </button>
    );
  }

  return (
    <select
      value={staffFilter}
      onChange={e => {
        const next = new URLSearchParams(searchParams);
        if (e.target.value) next.set('staff', e.target.value);
        else next.delete('staff');
        setSearchParams(next, { replace: true });
      }}
      style={{
        padding: '6px 10px', fontSize: 12, borderRadius: 6,
        border: '1px solid #D5D9DE', background: '#FFFFFF', color: '#4B5563',
      }}
    >
      <option value="">Staff: all</option>
      {employees
        .filter(e => e.employmentStatus !== 'inactive')
        .map(emp => (
          <option key={emp.id} value={emp.id}>{emp.name}</option>
        ))}
    </select>
  );
}
