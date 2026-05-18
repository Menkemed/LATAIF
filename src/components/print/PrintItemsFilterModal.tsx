// PrintItemsFilterModal (2026-05-18) — kleines Modal zum Auswahl des
// Filters vor dem Print/PDF-Export. Wird von AgentDetail, AgentList,
// ConsignorDetail und ConsignmentList wiederverwendet.
//
// Filter-Optionen: All / Sold / Open (Not Sold) / Returned.
// Default: 'all'. Bei Confirm ruft onConfirm(filter) auf — der Caller
// baut die Groups und ruft printItemListPdf().
import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { ItemListFilter } from '@/core/pdf/itemListPdf';

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (filter: ItemListFilter) => void;
  kind: 'approval' | 'consignment';
  scope: 'single' | 'all';
  /** Untertitel-Detail (z.B. Personen-Name bei single oder "all 12 consignors"). */
  contextLabel?: string;
  defaultFilter?: ItemListFilter;
}

const OPTIONS: { value: ItemListFilter; label: string; description: string }[] = [
  { value: 'all',      label: 'All Items',         description: 'Includes every status (active, sold, returned).' },
  { value: 'sold',     label: 'Sold Items',        description: 'Only items already sold.' },
  { value: 'open',     label: 'Open / Not Sold',   description: 'Still with the client / actively on consignment.' },
  { value: 'returned', label: 'Returned Items',    description: 'Items returned to owner / pulled back.' },
];

export function PrintItemsFilterModal({
  open, onClose, onConfirm, kind, scope, contextLabel, defaultFilter = 'all',
}: Props) {
  const [filter, setFilter] = useState<ItemListFilter>(defaultFilter);

  // Reset to default each time the modal opens.
  useEffect(() => {
    if (open) setFilter(defaultFilter);
  }, [open, defaultFilter]);

  const title = scope === 'single' ? 'Print Items' : (kind === 'approval' ? 'Print All Approvals' : 'Print All Consignors');
  const subtitle = scope === 'single'
    ? `Choose which items to include in the printed list${contextLabel ? ` for ${contextLabel}` : ''}.`
    : `Choose which items to include — one section per ${kind === 'approval' ? 'agent' : 'consignor'}${contextLabel ? ` (${contextLabel})` : ''}.`;

  return (
    <Modal open={open} onClose={onClose} title={title} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ fontSize: 12, color: '#6B7280' }}>{subtitle}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {OPTIONS.map(opt => {
            const selected = filter === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  textAlign: 'left',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: `1px solid ${selected ? '#0F0F10' : '#E5E9EE'}`,
                  background: selected ? 'rgba(15,15,16,0.04)' : '#FFFFFF',
                  color: '#0F0F10',
                  width: '100%',
                }}
              >
                <span
                  style={{
                    width: 14, height: 14, marginTop: 2, borderRadius: 999,
                    border: `2px solid ${selected ? '#0F0F10' : '#D5D9DE'}`,
                    background: selected ? '#0F0F10' : 'transparent',
                    flexShrink: 0,
                    boxShadow: selected ? 'inset 0 0 0 2px #FFFFFF' : 'none',
                  }}
                />
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#0F0F10' }}>{opt.label}</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{opt.description}</div>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onConfirm(filter); onClose(); }}>
            <Printer size={14} /> Print
          </Button>
        </div>
      </div>
    </Modal>
  );
}
