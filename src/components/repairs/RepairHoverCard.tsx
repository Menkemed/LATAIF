// ════════════════════════════════════════════════════════════════════════════
// REPAIR-HOVER — große Hover-Karte der Reparaturliste (Muster: Collections-Inventur `StockCheckInventoryModal`).
// Inhalt ausschließlich: Artikelbild (≈ 280 × 280, ganzes Bild, Hauptbild — erst beim Zeigen geladen),
// Marke, Modell, Referenz, Seriennummer. Fehlt eine Angabe, steht „—" — es wird nichts erfunden.
// Eigene Reparatur ohne eigenes Foto: das Bild des verknüpften Artikels (dieselbe Karten-Komponente und
// derselbe Cache wie in Collections). Nur lesend.
// ════════════════════════════════════════════════════════════════════════════
import { Wrench } from 'lucide-react';
import type { Product, Repair } from '@/core/models/types';
import { repairHoverFields } from '@/core/repairs/repair-hover';
import { useRepairCoverImage } from '@/hooks/useRepairCoverImage';
import { CollectionProductThumb } from '@/components/products/CollectionProductThumb';
import { useMediaScope } from '@/hooks/useMediaScope';

const IMG = 280;

export function RepairHoverCard({ repair, product }: { repair: Repair; product?: Product }) {
  const f = repairHoverFields(repair);
  const cover = useRepairCoverImage(repair.id, repair.images ?? []);
  const { tenantId, branchId } = useMediaScope();
  const rows: Array<[string, string | null, boolean]> = [
    ['Brand', f.brand, false],
    ['Model', f.model, false],
    ['Reference', f.reference, true],
    ['Serial number', f.serial, true],
  ];
  const bild = cover.status === 'media' || cover.status === 'legacy'
    ? <img src={cover.url} alt="" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} data-repair-hover-img={cover.status} />
    : cover.status === 'empty' && product
      ? <CollectionProductThumb product={product} tenantId={tenantId} branchId={branchId}
          imgStyle={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} iconSize={44} iconColor="#9CA3AF" />
      : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: '#9CA3AF', fontSize: 11 }} data-repair-hover-noimg={cover.status}>
          <Wrench size={40} strokeWidth={1} />
          {cover.status === 'loading' ? 'Loading photo…' : cover.status === 'error' ? 'Photo not available' : 'No photo'}
        </div>
      );
  return (
    <div data-repair-hover-card={repair.id} style={{
      width: IMG + 20, background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12,
      boxShadow: '0 14px 40px rgba(15,15,16,0.22)', overflow: 'hidden', padding: 10,
    }}>
      <div style={{
        width: IMG, height: IMG, borderRadius: 8, background: '#F2F7FA', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {bild}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 12px', padding: '10px 2px 2px', fontSize: 12 }}>
        {rows.map(([label, value, mono]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span style={{ color: '#6B7280', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', alignSelf: 'center' }}>{label}</span>
            <span className={mono && value ? 'font-mono' : undefined} data-repair-hover-field={label}
              style={{ color: value ? '#0F0F10' : '#9CA3AF', fontWeight: value ? 500 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {value ?? '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
