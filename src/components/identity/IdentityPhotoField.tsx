// ════════════════════════════════════════════════════════════════════════════
// MEDIA-IDENTITY §2/§3/§4/§10 — das Ausweisdokument auf dem Bildschirm.
//
// Eine Maske, drei Orte (Kunde, Lieferant, Einkauf) und genau eine Regel: was hier gezeigt wird,
// kommt über einen geprüften Leser und lebt nur so lange wie diese Ansicht. Es wird nirgends
// gespeichert — kein Zustand, der eine Daten-URL behält, kein Bild in einer Liste.
//
// Beim verknüpften Lieferanten sagt die Maske ausdrücklich, WESSEN Dokument sie zeigt, und bietet
// weder Austauschen noch Entfernen an: das gehört zum Kunden, und ein Knopf, der es hier still
// täte, wäre genau der Fehler, den §4 verbietet.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { IdCard, Trash2, Upload } from 'lucide-react';
import type { IdentityDocumentRef } from '@/core/models/types';
import { loadIdentityPhoto, revokeIdentityPhoto, type IdentityPhotoView } from '@/core/identity/identity-photo-view';
import { captureImage } from '@/core/media/capture-profile';

export interface IdentityPhotoFieldProps {
  /** Die Referenz aus der Geschäftsauskunft (`customer.identity` / `supplier.identity`). */
  refDoc: IdentityDocumentRef | null | undefined;
  /** Altbestand: die Daten-URL aus `suppliers.cpr_image`, wenn es noch keine Referenz gibt. */
  legacy?: string | null;
  /** `undefined` = unverändert, `null` = entfernen, Daten-URL = neues Bild. */
  value: string | null | undefined;
  onChange: (next: string | null | undefined) => void;
  /** Ohne Bearbeitungsrecht wird nur angezeigt. */
  editable?: boolean;
  label?: string;
}

const BOX: React.CSSProperties = {
  maxWidth: 240, maxHeight: 150, border: '1px solid #E5E9EE', borderRadius: 6,
  objectFit: 'contain', background: '#F2F7FA',
};

export function IdentityPhotoField({
  refDoc, legacy, value, onChange, editable = false, label = 'ID / CPR document',
}: IdentityPhotoFieldProps) {
  const [view, setView] = useState<IdentityPhotoView | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Das gespeicherte Dokument holen — und beim Verlassen wieder freigeben. `value` steuert das
  // NICHT: eine neue Aufnahme zeigt sich unten aus sich selbst, ohne den Leser zu bemühen.
  useEffect(() => {
    let abgelegt = false;
    let geholt: IdentityPhotoView | null = null;
    setError('');
    loadIdentityPhoto(refDoc, legacy)
      .then((v) => {
        geholt = v;
        if (abgelegt) { revokeIdentityPhoto(v); return; }
        setView(v);
      })
      .catch((e) => { if (!abgelegt) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      abgelegt = true;
      revokeIdentityPhoto(geholt);
      setView(null);
    };
    // Die Fassung gehört dazu: tauscht jemand das Dokument, ist die Referenz eine andere.
  }, [refDoc?.mediaId, refDoc?.generationNo, refDoc?.key, legacy]);

  const fromLinked = refDoc?.fromLinkedCustomer === true;
  const entfernt = value === null;
  const neu = typeof value === 'string' && value.startsWith('data:');
  const zeigen = neu ? value : (entfernt ? null : view?.url ?? null);

  async function waehlen(files: FileList | null): Promise<void> {
    const f = files?.[0];
    if (!f) return;
    setError('');
    try {
      // POST-PARITY R7B PP-12 / §6 — DERSELBE Normalisierer wie überall (JPEG, ≤ 100 000 B,
      // EXIF-Drehung, keine unnötige Vergrößerung). Kein eigener für Ausweise.
      onChange(await captureImage(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center', gap: 6 }}>
        <IdCard size={14} /> {label}
      </label>
      {fromLinked && (
        <div style={{ fontSize: 12, color: '#2563EB', background: '#EFF6FF', border: '1px solid #DBEAFE', borderRadius: 6, padding: '6px 8px' }}>
          Identity document from linked customer
        </div>
      )}
      {zeigen
        ? <img src={zeigen} alt={label} style={BOX} />
        : <div style={{ ...BOX, width: 240, height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9CA3AF', fontSize: 12 }}>
            {entfernt ? 'Will be removed on save' : 'No ID document'}
          </div>}
      {error && <div style={{ fontSize: 12, color: '#B91C1C' }}>{error}</div>}
      {editable && !fromLinked && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => { void waehlen(e.target.files); e.target.value = ''; }} />
          <button type="button" onClick={() => inputRef.current?.click()}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer' }}>
            <Upload size={13} /> {zeigen ? 'Replace' : 'Add'}
          </button>
          {/* Entfernen gilt dem Dokument im Medienspeicher. Ein reiner Altbestand (Bytes in der
              alten Spalte) bleibt stehen: er ist der Nachweis alter Einkaufsbelege, die keinen
              eigenen Abzug mitbekommen haben. */}
          {refDoc && !entfernt && (
            <button type="button" onClick={() => onChange(null)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer' }}>
              <Trash2 size={13} /> Remove
            </button>
          )}
          {(neu || entfernt) && (
            <button type="button" onClick={() => onChange(undefined)}
              style={{ fontSize: 12, padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer' }}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
