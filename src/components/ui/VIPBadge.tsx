import type { VIPLevel } from '@/core/models/types';

interface VIPBadgeProps {
  level: VIPLevel;
}

const labels: Record<VIPLevel, string> = { 0: '', 1: 'VIP', 2: 'VVIP', 3: 'Ultra' };

export function VIPBadge({ level }: VIPBadgeProps) {
  if (level === 0) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex gap-0.5">
        {Array(level).fill(0).map((_, i) => (
          <span key={i} style={{ fontSize: 9, color: '#0F0F10' }}>{'\u2666'}</span>
        ))}
      </span>
      <span className="text-overline" style={{ color: '#0F0F10', display: 'inline', marginBottom: 0 }}>
        {labels[level]}
      </span>
    </span>
  );
}
