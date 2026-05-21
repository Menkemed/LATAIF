// Back-to-Back Beschaffung — Wareneingang erfassen.
// Listet die un-beschafften Order-Posten, gruppiert nach geplantem Supplier
// (ordered_supplier_id). Der User waehlt die Posten EINER Lieferung → es oeffnet
// sich PurchaseCreate, vorbefuellt mit genau diesen Zeilen + Supplier.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useSupplierStore } from '@/stores/supplierStore';
import type { OrderLine } from '@/core/models/types';

interface Props {
  open: boolean;
  orderId: string;
  /** un-beschaffte PENDING/ORDERED customer-facing Produkt-Zeilen */
  lines: OrderLine[];
  onClose: () => void;
}

export function SourceItemsModal({ open, orderId, lines, onClose }: Props) {
  const navigate = useNavigate();
  const { suppliers, loadSuppliers } = useSupplierStore();
  useEffect(() => { if (open) loadSuppliers(); }, [open, loadSuppliers]);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setChecked(new Set(lines.map(l => l.id)));
  }, [open, lines]);

  // Posten nach geplantem Supplier gruppieren ('' = ohne Supplier).
  const groups = useMemo(() => {
    const m = new Map<string, OrderLine[]>();
    for (const l of lines) {
      const key = l.orderedSupplierId || '';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(l);
    }
    return Array.from(m.entries());
  }, [lines]);

  function toggle(id: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function proceed(supplierId: string, groupLines: OrderLine[]) {
    const ids = groupLines.filter(l => checked.has(l.id)).map(l => l.id);
    if (ids.length === 0) return;
    const params = new URLSearchParams();
    params.set('sourceOrderId', orderId);
    params.set('sourceOrderLineIds', ids.join(','));
    if (supplierId) params.set('supplier', supplierId);
    onClose();
    navigate(`/purchases/new?${params.toString()}`);
  }

  return (
    <Modal open={open} onClose={onClose} title="Wareneingang erfassen" width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ fontSize: 12, color: '#6B7280' }}>
          Waehle die Posten EINER Lieferung (= ein Supplier). „Wareneingang erfassen"
          oeffnet ein Purchase-Formular, vorbefuellt mit diesen Posten — Kosten + Zahlung
          gibst du dort ein. Posten verschiedener Supplier nacheinander erfassen.
        </p>
        {lines.length === 0 && (
          <p style={{ fontSize: 13, color: '#6B7280' }}>Keine offenen Posten zu beschaffen.</p>
        )}
        {groups.map(([sid, gl]) => {
          const supName = sid
            ? (suppliers.find(s => s.id === sid)?.name || sid.slice(0, 8))
            : 'Ohne Supplier — beim Purchase waehlen';
          const selCount = gl.filter(l => checked.has(l.id)).length;
          return (
            <div key={sid || 'none'} style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{
                padding: '8px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE',
                fontSize: 12, color: '#0F0F10', fontWeight: 500,
              }}>
                {sid ? '🏷 ' : ''}{supName}
              </div>
              {gl.map(l => (
                <label key={l.id} className="flex items-center gap-2 cursor-pointer"
                  style={{ padding: '8px 12px', borderBottom: '1px solid #F2F2F2', fontSize: 13 }}>
                  <input type="checkbox" checked={checked.has(l.id)} onChange={() => toggle(l.id)} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.description || '—'}
                  </span>
                  <span style={{ fontSize: 11, color: '#9CA3AF' }}>×{l.quantity}</span>
                  <span style={{ fontSize: 11, color: l.status === 'ORDERED' ? '#D97706' : '#6B7280' }}>{l.status}</span>
                </label>
              ))}
              <div className="flex justify-end" style={{ padding: '8px 12px' }}>
                <Button variant="primary" onClick={() => proceed(sid, gl)} disabled={selCount === 0}>
                  Wareneingang erfassen ({selCount})
                </Button>
              </div>
            </div>
          );
        })}
        <div className="flex justify-end" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Schliessen</Button>
        </div>
      </div>
    </Modal>
  );
}
