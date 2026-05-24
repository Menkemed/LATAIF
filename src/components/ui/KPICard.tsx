import { type ReactNode } from 'react';

interface KPICardProps {
  label: string;
  value: string | number;
  unit?: string;
  trend?: number;
  icon?: ReactNode;
  accent?: 'blue' | 'purple' | 'green' | 'orange' | 'urgent' | 'none';
  onClick?: () => void;
  tooltip?: string;
  /** Optional extra className (z.B. pulse-orange fuer Warnzeichen). */
  className?: string;
}

// Plan §Design v2 — moderner SaaS-Look:
// - Weiß-Card mit dezentem Border
// - Icon links oben in farbiger Box
// - Große Zahl mit kleiner Decimal/Unit
// - Trend-Pill (grün hoch / rot runter) wenn trend gegeben
export function KPICard({ label, value, unit, trend, icon, accent = 'none', onClick, tooltip, className }: KPICardProps) {
  // v0.7.9 — Decimal-Differenzierung: Ganzzahl gross, Dezimalteil klein (0.7em)
  // analog zu <Bhd>-Konvention. Vorher wurde "180.000" einheitlich gross
  // dargestellt; jetzt "180" gross + ".000" auf 70% der Hoehe.
  //
  // - number-input: ganzzahl-Format ohne Decimals (bisheriges Verhalten).
  // - string-input: bei "x.yyy"-Form aufteilen (z.B. fmt(180) = "180.000"
  //   wird zu intPart="180" + decimalPart=".000"). Sonst as-is rendern.
  let intPart: string;
  let decimalPart = '';
  if (typeof value === 'number') {
    intPart = value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  } else {
    const str = String(value);
    const m = str.match(/^([-+]?[\d,]+)(\.\d+)$/);
    if (m) {
      intPart = m[1];
      decimalPart = m[2];
    } else {
      intPart = str;
    }
  }

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
      className={`cx-card ${onClick ? 'cursor-pointer' : ''}${className ? ' ' + className : ''}`}
      title={tooltip}
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
          {intPart}
          {decimalPart && (
            // Konsistent mit Bhd: nur Groesse reduzieren, Farbe + Weight vom
            // Parent erben — damit Decimal-Teil identisch schwarz bleibt wie
            // ueberall sonst und nicht grau wirkt.
            <span style={{ fontSize: '0.7em' }}>{decimalPart}</span>
          )}
        </div>
        {trendDisplay}
      </div>

      {unit && (
        <span style={{ fontSize: 12, color: '#6B7280', display: 'block' }}>{unit}</span>
      )}
    </div>
  );
}
