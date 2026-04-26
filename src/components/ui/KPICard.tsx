import { type ReactNode } from 'react';

interface KPICardProps {
  label: string;
  value: string | number;
  unit?: string;
  trend?: number;
  icon?: ReactNode;
  accent?: 'lime' | 'mint' | 'none' | 'urgent';
  onClick?: () => void;
}

export function KPICard({ label, value, unit, trend, icon, accent = 'none', onClick }: KPICardProps) {
  const formatted = typeof value === 'number'
    ? value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : value;

  const bg = accent === 'lime' ? '#E9FF5E'
    : accent === 'mint' ? '#C4E3EC'
    : accent === 'urgent' ? 'rgba(220,38,38,0.06)'
    : '#FFFFFF';
  const border = accent === 'urgent' ? '1px solid rgba(220,38,38,0.3)'
    : accent === 'none' ? '1px solid #E5E1D6'
    : 'none';

  return (
    <div
      className={`rounded-[28px] transition-all duration-300 ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        background: bg,
        border,
        padding: '28px 28px 24px',
      }}
      onClick={onClick}
      onMouseEnter={e => {
        if (accent === 'none') e.currentTarget.style.borderColor = '#D5D1C4';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        if (accent === 'none') e.currentTarget.style.borderColor = '#E5E1D6';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
        <span className="text-overline">{label}</span>
        {icon && <span style={{ color: '#6B7280' }}>{icon}</span>}
      </div>

      <div className="font-display" style={{ fontSize: 38, lineHeight: '44px', letterSpacing: '-0.02em', color: '#0F0F10' }}>
        {formatted}
      </div>

      {unit && (
        <span style={{ fontSize: 12, color: '#4B5563', display: 'block', marginTop: 4 }}>{unit}</span>
      )}

      {trend !== undefined && (
        <div className="flex items-center gap-1" style={{ marginTop: 14, fontSize: 13, color: trend >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
          <span>{trend >= 0 ? '\u2191' : '\u2193'}</span>
          <span>{Math.abs(trend)}%</span>
        </div>
      )}
    </div>
  );
}
