// Plan §Design v2 — Halbkreis-Gauge wie Image #14 (Sales Overview)
// Säulen im Bogen, gefüllt entsprechend percent-Wert.
interface GaugeChartProps {
  percent: number; // 0..100
  label?: string;
  sublabel?: string;
  segments?: number;
  fillColor?: string;
  emptyColor?: string;
}

export function GaugeChart({
  percent,
  label,
  sublabel,
  segments = 14,
  fillColor = '#3D7FFF',
  emptyColor = '#E5E9EE',
}: GaugeChartProps) {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * segments);

  // Halbkreis-Layout: Segmente von links unten (180°) bis rechts unten (0°)
  // Für jedes Segment: Winkel berechnen, Position als Bar
  const radius = 110;
  const segmentAngle = 180 / segments;
  const segmentWidth = 18;
  const segmentHeight = 38;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0' }}>
      <svg width="280" height="170" viewBox="-140 -130 280 170" style={{ overflow: 'visible' }}>
        {Array.from({ length: segments }).map((_, i) => {
          // Winkel: 180° (links) - 0° (rechts)
          const angle = 180 - (i * segmentAngle) - segmentAngle / 2;
          const rad = (angle * Math.PI) / 180;
          const x = Math.cos(rad) * radius;
          const y = -Math.sin(rad) * radius;
          const isFilled = i < filled;

          // Gradient-Effekt: später Segmente leicht heller
          let color = emptyColor;
          if (isFilled) {
            const lightening = (i / segments) * 0.5;
            color = mixColors(fillColor, '#FFFFFF', lightening);
          }

          return (
            <rect
              key={i}
              x={-segmentWidth / 2}
              y={-segmentHeight / 2}
              width={segmentWidth}
              height={segmentHeight}
              rx={9}
              fill={color}
              transform={`translate(${x}, ${y}) rotate(${-angle + 90})`}
            />
          );
        })}
      </svg>
      <div style={{ marginTop: -60, textAlign: 'center' }}>
        {label && (
          <div style={{ fontFamily: 'Inter', fontSize: 32, fontWeight: 700, color: '#0F0F10', letterSpacing: '-0.025em' }}>
            {label}
          </div>
        )}
        {sublabel && (
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 2 }}>
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
}

// Hilfsfunktion: zwei Hex-Farben mischen
function mixColors(c1: string, c2: string, ratio: number): string {
  const hex = (h: string) => parseInt(h, 16);
  const r1 = hex(c1.slice(1, 3)), g1 = hex(c1.slice(3, 5)), b1 = hex(c1.slice(5, 7));
  const r2 = hex(c2.slice(1, 3)), g2 = hex(c2.slice(3, 5)), b2 = hex(c2.slice(5, 7));
  const r = Math.round(r1 * (1 - ratio) + r2 * ratio);
  const g = Math.round(g1 * (1 - ratio) + g2 * ratio);
  const b = Math.round(b1 * (1 - ratio) + b2 * ratio);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
