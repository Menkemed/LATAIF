import { type ReactNode } from 'react';

interface KPICardProps {
  label: string;
  value: string | number;
  unit?: string;
  trend?: number;
  icon?: ReactNode;
  accent?: 'blue' | 'purple' | 'green' | 'orange' | 'urgent' | 'none';
  onClick?: () => void;
}

// Plan §Design v2 — moderner SaaS-Look:
// - Weiß-Card mit dezentem Border
// - Icon links oben in farbiger Box
// - Große Zahl mit kleiner Decimal/Unit
// - Trend-Pill (grün hoch / rot runter) wenn trend gegeben
export function KPICard({ label, value, unit, trend, icon, accent = 'none', onClick }: KPICardProps) {
  // Zahl formatieren mit Decimal-Differenzierung (5,567.00 → 5,567 + .00)
  const numString = typeof value === 'number'
    ? value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : String(value);

  const accentColors: Record<string, { bg: string; fg: string }> = {
    blue:    { bg: 'rgba(61,127,255,0.10)',  fg: '#3D7FFF' },
    purple:  { bg: 'rgba(113,93,227,0.10)',  fg: '#715DE3' },
    green:   { bg: 'rgba(22,163,74,0.10)',   fg: '#16A34A' },
    orange:  { bg: 'rgba(255,135,48,0.10)',  fg: '#FF8730' },
    urgent:  { bg: 'rgba(220,38,38,0.10)',   fg: '#DC2626' },
    none:    { bg: '#F2F7FA',                fg: '#6B7280' },
  };
  const ac = accentColors[accent];

  const trendDisplay = trend !== undefined && (
    <span
      className={trend >= 0 ? 'trend-pill trend-pill-up' : 'trend-pill trend-pill-down'}
    >
      {trend >= 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}%
    </span>
  );

  return (
    <div
      className={`cx-card ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        background: '#FFFFFF',
        border: accent === 'urgent' ? '1px solid rgba(220,38,38,0.25)' : '1px solid #E5E9EE',
        borderRadius: 20,
        padding: '20px 22px',
        transition: 'all 0.2s',
      }}
      onClick={onClick}
      onMouseEnter={e => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 6px 20px rgba(15,15,16,0.06)';
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {/* Icon + Label-Reihe */}
      <div className="flex items-center gap-2" style={{ marginBottom: 14 }}>
        {icon && (
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            background: ac.bg, color: ac.fg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {icon}
          </div>
        )}
        <span style={{
          fontSize: 12, fontWeight: 500, color: '#6B7280',
          letterSpacing: '0.02em',
        }}>{label}</span>
      </div>

      {/* Große Zahl + Trend */}
      <div className="flex items-end justify-between" style={{ marginBottom: unit ? 4 : 0, gap: 8 }}>
        <div style={{
          fontFamily: 'Inter, sans-serif',
          fontSize: 32, fontWeight: 600, letterSpacing: '-0.025em',
          color: '#0F0F10', lineHeight: 1.1,
        }}>
          {numString}
        </div>
        {trendDisplay}
      </div>

      {unit && (
        <span style={{ fontSize: 12, color: '#6B7280', display: 'block' }}>{unit}</span>
      )}
    </div>
  );
}
