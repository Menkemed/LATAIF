import { useEffect, useState, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { TaxScheme } from '@/core/models/types';

export interface TaxSchemeLine {
  id: string;
  label: string;
  currentScheme: TaxScheme;
  /** CUSTOM-ORDER K2 — der Bruttopreis der Zeile (bleibt bei jeder Steuerart gleich); nur Anzeige. */
  gross?: number;
}

/** CUSTOM-ORDER K2 — optional: Rechnungsdatum und Nummernart im SELBEN Dialog (Create Invoice einer Order). */
export interface InvoiceDialogExtras {
  invoiceDate: string;
  maxDate: string;
  onInvoiceDateChange: (d: string) => void;
  specialMark: boolean;
  onSpecialMarkChange: (v: boolean) => void;
  /** Fehlermeldung zum Datum (leer = in Ordnung). */
  dateError?: string;
}

interface Props {
  open: boolean;
  lines: TaxSchemeLine[];
  onCancel: () => void;
  onConfirm: (perLine: Record<string, TaxScheme>) => void;
  title?: string;
  confirmLabel?: string;
  extras?: InvoiceDialogExtras;
}

const SCHEMES: { key: TaxScheme; label: string; desc: string }[] = [
  { key: 'MARGIN', label: 'Margin', desc: 'Tax on profit (hidden from customer)' },
  { key: 'VAT_10', label: 'VAT 10%', desc: 'VAT 10% on net price' },
  { key: 'ZERO', label: 'Zero', desc: '0% — no VAT' },
];

export function ConfirmTaxSchemeModal({
  open, lines, onCancel, onConfirm,
  title = 'Create Invoice', confirmLabel = 'Create Invoice', extras,
}: Props) {
  const [schemes, setSchemes] = useState<Record<string, TaxScheme>>({});

  useEffect(() => {
    if (open) {
      const init: Record<string, TaxScheme> = {};
      for (const l of lines) init[l.id] = l.currentScheme;
      setSchemes(init);
    }
  }, [open, lines]);

  const bulkValue: TaxScheme | 'mixed' = useMemo(() => {
    const vals = Object.values(schemes);
    if (vals.length === 0) return 'mixed';
    const first = vals[0];
    return vals.every(v => v === first) ? first : 'mixed';
  }, [schemes]);

  function applyToAll(s: TaxScheme) {
    const next: Record<string, TaxScheme> = {};
    for (const l of lines) next[l.id] = s;
    setSchemes(next);
  }

  function pill(active: boolean) {
    return {
      padding: '6px 12px',
      fontSize: 12,
      borderRadius: 6,
      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
      color: active ? '#0F0F10' : '#6B7280',
      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
      cursor: 'pointer',
    } as const;
  }

  return (
    <Modal open={open} onClose={onCancel} title={title} width={600}>
      <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 14 }}>
        Review the VAT scheme for each line. You can change per line or apply one to all.
        {extras && ' The customer price (gross) stays the same for every scheme.'}
      </p>

      {extras && (
        <div className="flex gap-4" style={{ marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-overline">INVOICE DATE</span>
            <input type="date" data-testid="order-invoice-date" value={extras.invoiceDate} max={extras.maxDate}
              onChange={(e) => extras.onInvoiceDateChange(e.target.value)}
              style={{ padding: '7px 9px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13 }} />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-overline">NUMBER TYPE</span>
            <div className="flex gap-1">
              <button type="button" data-testid="order-invoice-number-standard" onClick={() => extras.onSpecialMarkChange(false)} style={pill(!extras.specialMark)}>Standard</button>
              <button type="button" data-testid="order-invoice-number-special" onClick={() => extras.onSpecialMarkChange(true)} style={pill(extras.specialMark)}>Special</button>
            </div>
          </div>
          {extras.dateError && <span style={{ fontSize: 12, color: '#B91C1C' }}>{extras.dateError}</span>}
        </div>
      )}

      {/* Bulk apply */}
      <div style={{ marginBottom: 16, padding: '10px 12px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8 }}>
        <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>APPLY TO ALL LINES</span>
        <div className="flex gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {SCHEMES.map(s => (
            <button key={s.key} type="button" onClick={() => applyToAll(s.key)} style={pill(bulkValue === s.key)}>
              {s.label}
            </button>
          ))}
          {bulkValue === 'mixed' && (
            <span style={{ padding: '6px 10px', fontSize: 11, color: '#6B7280', fontStyle: 'italic' }}>Mixed — individual per line</span>
          )}
        </div>
      </div>

      {/* Per-line */}
      <div style={{ maxHeight: '45vh', overflowY: 'auto', border: '1px solid #E5E9EE', borderRadius: 8 }}>
        {lines.map((line, idx) => (
          <div key={line.id} style={{
            padding: '12px 14px',
            borderBottom: idx < lines.length - 1 ? '1px solid #E5E9EE' : 'none',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ flex: 1, fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {line.label}
            </span>
            {line.gross !== undefined && (
              <span className="font-mono" style={{ fontSize: 12, color: '#4B5563', flexShrink: 0 }}>{line.gross.toFixed(3)} BHD</span>
            )}
            <div className="flex gap-1" style={{ flexShrink: 0 }}>
              {SCHEMES.map(s => {
                const active = schemes[line.id] === s.key;
                return (
                  <button key={s.key} type="button" onClick={() => setSchemes({ ...schemes, [line.id]: s.key })} style={pill(active)}>
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {lines.length === 0 && (
          <div style={{ padding: 20, fontSize: 13, color: '#6B7280', textAlign: 'center' }}>No lines.</div>
        )}
      </div>

      <div className="flex justify-end gap-3" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => onConfirm(schemes)} disabled={lines.length === 0 || !!extras?.dateError}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
