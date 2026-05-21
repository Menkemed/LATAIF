// ═══════════════════════════════════════════════════════════
// LATAIF — Shared Materials Card (v0.2.1)
//
// Universelle Material-Liste fuer Repair + Custom-Order. Zeigt:
//  - Diamanten / Steine / Gold-Pieces als Tabelle
//  - Supplier-Info (A/P-Indikator wenn supplier_id gesetzt)
//  - Cost / Customer-Price je nach Kontext
//  - „Add Material" Button → oeffnet AddMaterialModal
//
// Beide Modules (Repair + Order) speichern Material in ihrer eigenen
// lines-Tabelle (repair_lines / order_lines) mit material_kind +
// material_details JSON.
// ═══════════════════════════════════════════════════════════

import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import type { MaterialDetails } from '@/core/models/types';

export interface MaterialLine {
  id: string;
  position?: number;
  materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | 'custom' | null;
  materialDetails?: MaterialDetails;
  description?: string;
  supplierId?: string;
  supplierName?: string;     // fuer Display, snapshot
  costAmount?: number;
  unitPrice?: number;         // bei Custom-Order: was Customer zahlt
  status?: string;
}

interface MaterialsCardProps {
  title?: string;
  lines: MaterialLine[];
  onAdd?: () => void;
  onRemove?: (id: string) => void;  // v0.5.0 — wenn gesetzt: Delete-Button pro Zeile
  showCustomerPrice?: boolean;  // Custom-Order: ja; Repair: nein
  canEdit?: boolean;
}

function materialKindBadgeColor(kind: string | null | undefined): { bg: string; fg: string } {
  switch (kind) {
    case 'diamond': return { bg: 'rgba(99, 102, 241, 0.08)', fg: '#4F46E5' };
    case 'stone':   return { bg: 'rgba(168, 85, 247, 0.08)', fg: '#7C3AED' };
    case 'gold':    return { bg: 'rgba(217, 119, 6, 0.08)', fg: '#92400E' };
    case 'labor':   return { bg: 'rgba(75, 85, 99, 0.08)', fg: '#374151' };
    case 'custom':  return { bg: 'rgba(198, 163, 109, 0.12)', fg: '#9A7B3F' };
    default:        return { bg: '#F2F7FA', fg: '#6B7280' };
  }
}

export function MaterialsCard({
  title = 'Materials Used',
  lines,
  onAdd,
  onRemove,
  showCustomerPrice = false,
  canEdit = true,
}: MaterialsCardProps) {
  // Nur material_kind != NULL anzeigen (labor wird in eigener Section gezeigt)
  const materials = lines.filter(l => l.materialKind && l.materialKind !== 'labor');
  const showRemove = !!onRemove && canEdit;

  return (
    <Card>
      <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
        <span className="text-overline">
          {title} ({materials.length})
        </span>
        {canEdit && onAdd && (
          <button
            onClick={onAdd}
            className="cursor-pointer"
            style={{
              padding: '6px 12px', fontSize: 12, borderRadius: 6,
              border: '1px solid #D5D9DE', background: 'transparent', color: '#0F0F10',
            }}
          >
            + Add Material
          </button>
        )}
      </div>
      {materials.length === 0 ? (
        <p style={{ fontSize: 13, color: '#6B7280', padding: '12px 0' }}>
          Keine Material-Eintraege. Klick „Add Material" um Diamant/Stein/Gold-Piece zu erfassen.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: (showCustomerPrice
              ? '0.6fr 1.2fr 0.6fr 1.3fr 0.7fr 0.8fr 0.8fr'
              : '0.6fr 1.2fr 0.6fr 1.4fr 0.7fr 0.8fr') + (showRemove ? ' 32px' : ''),
            gap: 12, fontSize: 12 }}>
          <span className="text-overline">KIND</span>
          <span className="text-overline">DESCRIPTION</span>
          <span className="text-overline" style={{ textAlign: 'right' }}>QTY/CT</span>
          <span className="text-overline">SUPPLIER</span>
          <span className="text-overline" style={{ textAlign: 'right' }}>COST/CT</span>
          <span className="text-overline" style={{ textAlign: 'right' }}>COST</span>
          {showCustomerPrice && (
            <span className="text-overline" style={{ textAlign: 'right' }}>CUST PRICE</span>
          )}
          {showRemove && <span />}
          {materials.map(l => {
            const c = materialKindBadgeColor(l.materialKind);
            const d = l.materialDetails || {};
            // v0.5.0 — Cost/Carat in der Zeile anzeigen (Diamond/Stone).
            const totalCt = (d.ct || 0) * (d.qty || 0);
            const perCt = (l.materialKind === 'diamond' || l.materialKind === 'stone') && totalCt > 0
              ? (l.costAmount || 0) / totalCt : 0;
            const qtyDisplay = l.materialKind === 'diamond' || l.materialKind === 'stone'
              ? `${d.qty || 1}× ${d.ct ? d.ct.toFixed(2) + 'ct' : ''}`
              : (d.qty != null ? `${d.qty}` : '—');
            return (
              <div key={l.id} style={{ display: 'contents' }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '4px 8px', borderRadius: 4,
                  color: c.fg, background: c.bg, textTransform: 'uppercase',
                  borderTop: '1px solid #E5E9EE', alignSelf: 'center',
                  justifySelf: 'start', marginTop: 8,
                }}>
                  {l.materialKind}
                </span>
                <span style={{ fontSize: 13, color: '#0F0F10', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                  {d.description || l.description || '—'}
                </span>
                <span className="font-mono" style={{ fontSize: 12, color: '#4B5563', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                  {qtyDisplay}
                </span>
                <span style={{ fontSize: 12, color: l.supplierId ? '#0F0F10' : '#9CA3AF', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                  {l.supplierName || d.supplierName || (l.supplierId ? l.supplierId.slice(0,8) : '— own stock')}
                </span>
                <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                  {perCt > 0 ? <Bhd v={perCt}/> : '—'}
                </span>
                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                  <Bhd v={l.costAmount || 0}/>
                </span>
                {showCustomerPrice && (
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE', fontWeight: 600 }}>
                    <Bhd v={l.unitPrice || l.costAmount || 0}/>
                  </span>
                )}
                {showRemove && (
                  <button
                    onClick={() => onRemove?.(l.id)}
                    className="cursor-pointer"
                    style={{ background: 'none', border: 'none', color: '#DC2626', fontSize: 16, lineHeight: 1, padding: '10px 0', borderTop: '1px solid #E5E9EE' }}
                    title="Entfernen"
                  >×</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
