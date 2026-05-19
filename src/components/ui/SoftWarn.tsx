// SoftWarn — kleiner gelber Hinweis-Block unter einem Form-Feld.
// Salesforce-Stil: niemals hart blockieren, nur informieren. Wenn `warning`
// leer ist, rendert nichts.

import { AlertTriangle } from 'lucide-react';

interface SoftWarnProps {
  warning?: string;
}

export function SoftWarn({ warning }: SoftWarnProps) {
  if (!warning) return null;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 6,
        marginTop: 6, padding: '6px 10px',
        background: 'rgba(217,119,6,0.06)',
        border: '1px solid rgba(217,119,6,0.25)',
        borderRadius: 6,
        fontSize: 11, color: '#92400E',
        lineHeight: 1.45,
      }}
    >
      <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{warning}</span>
    </div>
  );
}
