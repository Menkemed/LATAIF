// ARTIKELVARIANTEN — „Edit group": einzelne Artikel aus dem Modell nehmen, Artikel hinzufügen oder die Gruppierung ganz
// aufheben. Entfernt wird NUR die Zuordnung — Artikel, Bilder, Lose und Buchungen bleiben unverändert. Bleibt nur ein
// Artikel übrig, ist es kein Modell mehr (er erscheint wieder einzeln).
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { WriteError } from '@/components/shared/WriteError';
import { useProductStore } from '@/stores/productStore';
import { useSharedWrites } from '@/core/data/shared-write';
import { PRODUCT_MODELS_UNGROUP_OP, type RemoveResult } from '@/core/products/product-models';
import { removeFromModelOnPrimary } from '@/core/products/product-models-primary';
import { modelMembers, modelTitle, sizeOf, summarizeModel } from '@/core/products/product-models-view';

interface Props {
  open: boolean;
  modelKey: string;
  onClose: () => void;
  onAddItems: () => void;
}

export function EditGroupModal({ open, modelKey, onClose, onAddItems }: Props) {
  const { products, productModels, loadProducts } = useProductStore();
  const w = useSharedWrites();
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const members = modelMembers(products, productModels, modelKey);
  const summary = members.length ? summarizeModel(modelKey, members) : null;

  async function remove(ids: string[]) {
    const r = await w.save<RemoveResult>(PRODUCT_MODELS_UNGROUP_OP, {
      local: () => removeFromModelOnPrimary({ productIds: ids }),
      remote: () => ({ productIds: ids }),
    });
    if (r.kind !== 'ok') return;
    if (w.remote) loadProducts();
    setConfirmDissolve(false);
    if (ids.length >= members.length - 1) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={`Edit group${summary ? ` — ${modelTitle(summary)}` : ''}`} width={620}>
      <div data-edit-group-modal style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>
          Removing only deletes the model assignment. Items, photos, stock and bookings stay unchanged. If only one item is left, it is shown on its own again.
        </p>
        <div style={{ border: '1px solid #E5E9EE', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} style={{ borderTop: '1px solid #E5E9EE' }} data-edit-group-row={m.id}>
                  <td className="font-mono" style={{ padding: 8 }}>{m.sku || '—'}</td>
                  <td style={{ padding: 8 }}>Size {sizeOf(m) || '—'}</td>
                  <td style={{ padding: 8 }}><StatusDot status={m.stockStatus} /></td>
                  <td style={{ padding: 8, textAlign: 'right' }}>
                    <Button variant="ghost" disabled={w.busy} onClick={() => void remove([m.id])} data-edit-group-remove={m.id}>Remove from model</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {confirmDissolve && (
          <div style={{ fontSize: 12, padding: '10px 12px', borderLeft: '3px solid #B45309', background: '#FFF7E6', borderRadius: '0 8px 8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>Dissolve this model? {members.length} assignments are removed; the items are shown on their own again. Nothing else changes — shared photos stay on the items.</span>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirmDissolve(false)}>Cancel</Button>
              <Button variant="primary" disabled={w.busy} onClick={() => void remove(members.map((m) => m.id))} data-edit-group-dissolve-confirm>Dissolve</Button>
            </div>
          </div>
        )}
        <WriteError text={w.fehler} />
        <div className="flex justify-between gap-2" style={{ flexWrap: 'wrap' }}>
          <Button variant="ghost" disabled={w.busy || members.length === 0} onClick={() => setConfirmDissolve(true)} data-edit-group-dissolve>Dissolve group</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onAddItems} data-edit-group-add>Add items</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
