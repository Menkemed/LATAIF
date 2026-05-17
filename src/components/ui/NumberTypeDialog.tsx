import { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

// 2026-05-16 — Number Type Dialog.
//
// Erscheint an allen Stellen wo eine Final-Rechnung entsteht / werden kann:
//   - Direct Invoice Create (bei Vollzahlung)
//   - Offer → Invoice
//   - Order → Invoice
//   - Consignment → Invoice
//   - Repair → Repair-Invoice
//   - Partial → Final (Vollzahlung spaeter)
//
// Auswahl: Normal Final (Default) oder Special Final (mit Punkt-Praefix).
// Cancel = Abbruch des Save/Convert (keine Rechnung wird erstellt).

interface NumberTypeDialogProps {
  open: boolean;
  /** 'sales' → "No: 000009 / .000009";  'repair' → "Repair-000001 / .Repair-000001" */
  variant?: 'sales' | 'repair';
  /** Optionale Sequenz-Vorschau (z.B. "000010"). Wenn weggelassen → Platzhalter. */
  previewSeq?: string;
  /** Wahl getroffen: special = true → Punkt-Praefix. */
  onConfirm: (special: boolean) => void;
  /** Cancel → Save/Convert abbrechen. */
  onCancel: () => void;
  title?: string;
}

export function NumberTypeDialog({
  open, variant = 'sales', previewSeq, onConfirm, onCancel,
  title = 'Choose Invoice Number Type',
}: NumberTypeDialogProps) {
  const [special, setSpecial] = useState(false);

  // Default zuruecksetzen wenn Dialog neu geoeffnet wird.
  useEffect(() => { if (open) setSpecial(false); }, [open]);

  const seq = previewSeq || (variant === 'repair' ? '000001' : '000001');
  const normalLabel = variant === 'repair' ? `Repair-${seq}` : `No: ${seq}`;
  const specialLabel = variant === 'repair' ? `.Repair-${seq}` : `No: .${seq}`;

  return (
    <Modal open={open} onClose={onCancel} title={title} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          The dot prefix is a visual marker for special invoices. It does not
          affect bookkeeping — only how the number is displayed.
        </p>

        <NumberOption
          selected={!special}
          onClick={() => setSpecial(false)}
          label="Normal Final"
          preview={normalLabel}
          hint="Standard final invoice number."
        />
        <NumberOption
          selected={special}
          onClick={() => setSpecial(true)}
          label="Special Final"
          preview={specialLabel}
          hint="Marked with a leading dot."
        />

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => onConfirm(special)}>Confirm</Button>
        </div>
      </div>
    </Modal>
  );
}

function NumberOption({
  selected, onClick, label, preview, hint,
}: { selected: boolean; onClick: () => void; label: string; preview: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        textAlign: 'left',
        padding: '14px 16px',
        borderRadius: 12,
        border: selected ? '2px solid #715DE3' : '1px solid #E5E9EE',
        background: selected ? 'rgba(113,93,227,0.06)' : '#FFFFFF',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      <div
        style={{
          width: 18, height: 18, borderRadius: '50%',
          border: selected ? '5px solid #715DE3' : '2px solid #CBD5E1',
          background: '#FFFFFF',
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10' }}>{label}</span>
          <span className="font-mono" style={{ fontSize: 13, color: '#715DE3', fontWeight: 500 }}>{preview}</span>
        </div>
        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{hint}</div>
      </div>
    </button>
  );
}
