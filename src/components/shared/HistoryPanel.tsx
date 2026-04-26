// ═══════════════════════════════════════════════════════════
// LATAIF — History Panel (Plan §History/Audit §7)
// Zeigt komplette Audit-Historie für ein Dokument/Produkt.
// Unveränderbar — nur Lese-Ansicht (Plan §13).
// ═══════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { X, History as HistoryIcon } from 'lucide-react';
import { getAuditForEntity, type AuditEntry } from '@/core/audit/audit-log';

interface Props {
  entityType: string;
  entityId: string;
  title?: string;
  onClose?: () => void;
}

function formatValue(v: string | undefined): string {
  if (!v) return '—';
  try {
    const parsed = JSON.parse(v);
    if (typeof parsed === 'object') return JSON.stringify(parsed);
    return String(parsed);
  } catch {
    return v;
  }
}

function colorForAction(action: string): string {
  switch (action) {
    case 'CREATE': return '#16A34A';
    case 'UPDATE': return '#2563EB';
    case 'DELETE': return '#DC2626';
    case 'STATUS_CHANGE': return '#D97706';
    case 'PAYMENT': return '#0F0F10';
    case 'REFUND': return '#DC2626';
    default: return '#6B7280';
  }
}

export function HistoryPanel({ entityType, entityId, title = 'History', onClose }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    setEntries(getAuditForEntity(entityType, entityId));
  }, [entityType, entityId]);

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width: 480, zIndex: 9998,
      background: '#FFFFFF', borderLeft: '1px solid #E5E9EE',
      display: 'flex', flexDirection: 'column',
    }}>
      <div className="flex items-center justify-between" style={{ padding: '20px 24px', borderBottom: '1px solid #E5E9EE' }}>
        <div className="flex items-center gap-2">
          <HistoryIcon size={16} style={{ color: '#0F0F10' }} />
          <h3 style={{ fontSize: 16, color: '#0F0F10', fontWeight: 500 }}>{title}</h3>
          <span style={{ fontSize: 12, color: '#6B7280' }}>({entries.length})</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280' }}>
            <X size={18} />
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {entries.length === 0 ? (
          <p style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', padding: '48px 0' }}>
            Keine Aktivität bisher.
          </p>
        ) : (
          entries.map(e => (
            <div key={e.id} style={{
              padding: '12px 14px', marginBottom: 10,
              background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8,
            }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                  color: colorForAction(e.actionType), textTransform: 'uppercase',
                }}>{e.actionType}</span>
                <span style={{ fontSize: 11, color: '#6B7280' }}>
                  {new Date(e.changedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </div>
              {e.fieldName && (
                <div style={{ fontSize: 12, color: '#4B5563', marginBottom: 4 }}>
                  Field: <span style={{ color: '#0F0F10', fontFamily: 'monospace' }}>{e.fieldName}</span>
                </div>
              )}
              {e.oldValue !== undefined && e.oldValue !== null && (
                <div style={{ fontSize: 12, color: '#6B7280', fontFamily: 'monospace', marginBottom: 2 }}>
                  <span style={{ color: '#DC2626' }}>−</span> {formatValue(e.oldValue)}
                </div>
              )}
              {e.newValue !== undefined && e.newValue !== null && (
                <div style={{ fontSize: 12, color: '#6B7280', fontFamily: 'monospace' }}>
                  <span style={{ color: '#16A34A' }}>+</span> {formatValue(e.newValue)}
                </div>
              )}
              {e.changedBy && (
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>
                  by {e.changedBy}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Drawer with backdrop — drop-in for any detail page
interface DrawerProps {
  open: boolean;
  onClose: () => void;
  entityType: string;
  entityId: string;
  title?: string;
}

export function HistoryDrawer({ open, onClose, entityType, entityId, title }: DrawerProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0" style={{ zIndex: 9997 }}>
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(15,15,16,0.35)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />
      <HistoryPanel entityType={entityType} entityId={entityId} title={title} onClose={onClose} />
    </div>
  );
}
