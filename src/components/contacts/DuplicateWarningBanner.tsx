// Banner der in jedem Create/Edit-Modal erscheint wenn die aktuelle Eingabe
// einem bestehenden Kontakt aehnelt. Soft-warning — Save bleibt aktiv.
//
// Used by: QuickCustomerModal, CustomerList, SupplierList, AgentList,
// PartnersPage, EmployeeList.

import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { ContactLike, DuplicateMatch } from '@/core/contacts/duplicate-check';
import { matchSummary } from '@/core/contacts/duplicate-check';

interface Props<T extends ContactLike> {
  matches: DuplicateMatch<T>[];
  entityLabel: string;                            // z.B. "client", "supplier"
  onSelectMatch?: (contact: T) => void;           // Klick auf Match-Zeile (z.B. zu Detail navigieren)
  maxVisible?: number;                            // default 5
}

function displayName(c: ContactLike): string {
  const fn = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  if (fn) return fn;
  return c.name || c.company || '—';
}

export function DuplicateWarningBanner<T extends ContactLike>({
  matches, entityLabel, onSelectMatch, maxVisible = 5,
}: Props<T>) {
  if (matches.length === 0) return null;
  const visible = matches.slice(0, maxVisible);
  const more = matches.length - visible.length;
  const strongCount = matches.filter(m => m.strength === 'strong').length;
  const headline = strongCount > 0
    ? `Likely duplicate — ${strongCount} ${entityLabel}${strongCount === 1 ? '' : 's'} with the same phone or WhatsApp`
    : `Similar ${entityLabel}${matches.length === 1 ? '' : 's'} found — check before creating`;
  const accentBg = strongCount > 0 ? 'rgba(220,38,38,0.06)' : 'rgba(255,135,48,0.06)';
  const accentFg = strongCount > 0 ? '#DC2626' : '#FF8730';
  const accentBorder = strongCount > 0 ? 'rgba(220,38,38,0.30)' : 'rgba(255,135,48,0.30)';

  return (
    <div
      role="alert"
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        background: accentBg,
        border: `1px solid ${accentBorder}`,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div className="flex items-center gap-2" style={{ color: accentFg }}>
        <AlertTriangle size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{headline}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.map(m => {
          const c = m.contact;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelectMatch?.(c)}
              className={onSelectMatch ? 'cursor-pointer transition-colors' : ''}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px',
                background: '#FFFFFF',
                border: '1px solid rgba(0,0,0,0.06)', borderRadius: 8,
                textAlign: 'left',
                cursor: onSelectMatch ? 'pointer' : 'default',
              }}
              onMouseEnter={e => { if (onSelectMatch) e.currentTarget.style.background = '#F2F7FA'; }}
              onMouseLeave={e => { if (onSelectMatch) e.currentTarget.style.background = '#FFFFFF'; }}
            >
              <span style={{
                padding: '2px 8px', fontSize: 10, fontWeight: 500, borderRadius: 999,
                color: m.strength === 'strong' ? '#DC2626' : '#FF8730',
                background: m.strength === 'strong' ? 'rgba(220,38,38,0.08)' : 'rgba(255,135,48,0.10)',
                whiteSpace: 'nowrap',
              }}>
                {m.strength === 'strong' ? 'STRONG' : 'SOFT'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName(c)}
                  {c.company && <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>· {c.company}</span>}
                </div>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                  {matchSummary(m)}
                  {c.phone && <span className="font-mono" style={{ marginLeft: 8 }}>{c.phone}</span>}
                </div>
              </div>
              {onSelectMatch && <ExternalLink size={12} style={{ color: '#6B7280' }} />}
            </button>
          );
        })}
        {more > 0 && (
          <div style={{ fontSize: 11, color: '#6B7280', paddingLeft: 4 }}>
            …and {more} more
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: '#6B7280' }}>
        You can still create this {entityLabel} if it's a different person.
      </div>
    </div>
  );
}
