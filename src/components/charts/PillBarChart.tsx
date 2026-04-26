// Plan §Design v2 — Pill-shaped Bar-Chart wie Image #15 (Revenue Insights)
// Lange schmale Pills, eine pro Datenpunkt, hover zeigt Tooltip.
import { useState } from 'react';

interface DataPoint {
  label: string;
  value: number;
}

interface PillBarChartProps {
  data: DataPoint[];
  height?: number;
  highlightColor?: string;
  baseColor?: string;
  formatValue?: (v: number) => string;
}

export function PillBarChart({
  data,
  height = 240,
  highlightColor = '#3D7FFF',
  baseColor = '#E5E9EE',
  formatValue = (v) => v.toLocaleString('en-US'),
}: PillBarChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const max = Math.max(...data.map(d => d.value), 1);

  const barWidth = 100 / data.length;

  return (
    <div style={{ position: 'relative', paddingTop: 40 }}>
      {/* Y-Achsen-Linien */}
      <div style={{ position: 'relative', height, marginBottom: 8 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
          <div key={i} style={{
            position: 'absolute', left: 0, right: 0,
            bottom: `${p * 100}%`, height: 1,
            borderTop: '1px dashed #E5E9EE',
          }} />
        ))}

        {/* Y-Werte links */}
        <div style={{
          position: 'absolute', left: -36, top: 0, bottom: 0,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          fontSize: 10, color: '#9CA3AF',
        }}>
          {[1, 0.75, 0.5, 0.25, 0].map((p, i) => (
            <span key={i}>{formatValue(max * p)}</span>
          ))}
        </div>

        {/* Bars */}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'flex-end',
        }}>
          {data.map((d, i) => {
            const h = (d.value / max) * 100;
            const isHovered = hoverIdx === i;
            return (
              <div key={i}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                style={{
                  flex: 1,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  position: 'relative',
                  cursor: 'pointer',
                }}
              >
                {/* Tooltip oberhalb der Bar */}
                {isHovered && (
                  <div style={{
                    position: 'absolute',
                    bottom: `calc(${h}% + 18px)`,
                    background: highlightColor,
                    color: '#FFFFFF',
                    padding: '6px 14px',
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    zIndex: 10,
                  }}>
                    {formatValue(d.value)}
                    <div style={{
                      position: 'absolute',
                      bottom: -5, left: '50%',
                      transform: 'translateX(-50%) rotate(45deg)',
                      width: 8, height: 8,
                      background: highlightColor,
                    }} />
                  </div>
                )}
                {/* Bar */}
                <div style={{
                  width: Math.max(8, barWidth * 0.55) + '%',
                  height: `${h}%`,
                  background: isHovered
                    ? `linear-gradient(180deg, ${highlightColor} 0%, ${highlightColor}AA 100%)`
                    : baseColor,
                  borderRadius: 999,
                  transition: 'background 0.15s',
                  minHeight: 6,
                }} />
              </div>
            );
          })}
        </div>
      </div>

      {/* X-Achsen-Labels */}
      <div style={{
        display: 'flex',
        fontSize: 11, color: '#9CA3AF', fontWeight: 500,
        marginLeft: 0,
      }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center' }}>
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
