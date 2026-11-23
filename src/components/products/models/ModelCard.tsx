// ARTIKELVARIANTEN — eine Karte je Modell in der Collection: gemeinsames Bild, verfügbare Größen mit Stückzahl,
// verkaufte Größen durchgestrichen (sichtbar, nicht im Bestand), Preisspanne der verfügbaren Stücke.
import { Layers } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { CollectionProductThumb } from '@/components/products/CollectionProductThumb';
import type { Category } from '@/core/models/types';
import type { ModelSummary } from '@/core/products/product-models-view';

interface Props {
  summary: ModelSummary;
  category: Category | undefined;
  tenantId: string | undefined;
  branchId: string | undefined;
  onOpen: () => void;
}

export function ModelCard({ summary, category, tenantId, branchId, onOpen }: Props) {
  const s = summary;
  const consignment = s.members.some((m) => m.sourceType === 'CONSIGNMENT');
  return (
    <div data-model-card={s.key} style={{ position: 'relative', paddingRight: 8, paddingBottom: 8 }}>
      {/* gestapelte Ränder: ein Modell sind mehrere Artikel */}
      <div aria-hidden style={{ position: 'absolute', inset: '8px 0 0 8px', borderRadius: 14, border: '1px solid #E5E9EE', background: '#FAFBFC' }} />
      <div aria-hidden style={{ position: 'absolute', inset: '4px 4px 4px 4px', borderRadius: 14, border: '1px solid #D5D9DE', background: '#FFFFFF' }} />
      <Card hoverable noPadding onClick={onOpen} style={{ position: 'relative' }}>
        <div className="flex items-center justify-center relative"
          style={{ height: 180, background: '#F2F7FA', borderBottom: '1px solid #E5E9EE', overflow: 'hidden' }}>
          <CollectionProductThumb product={s.representative} tenantId={tenantId} branchId={branchId} iconSize={36} />
          <span className="absolute flex items-center gap-1" style={{ top: 12, left: 12, gap: 6, display: 'flex', flexWrap: 'wrap' }}>
            {category && (
              <span style={{ fontSize: 10, padding: '2px 10px', borderRadius: 999, background: category.color + '15', color: category.color, border: `1px solid ${category.color}30` }}>{category.name}</span>
            )}
            <span data-model-badge style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(113,93,227,0.09)', color: '#5B3DCC', border: '1px solid rgba(113,93,227,0.35)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Layers size={11} /> Model · {s.members.length} items
            </span>
            {consignment && (
              <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(110,138,170,0.12)', color: '#3F5B7A', border: '1px solid rgba(110,138,170,0.45)' }}>Consignment</span>
            )}
          </span>
        </div>
        <div style={{ padding: '18px 22px 22px' }}>
          <span className="text-overline">{s.brand ? `${s.brand} · MODEL` : 'MODEL'}</span>
          <h3 className="font-display" style={{ fontSize: 18, color: '#0F0F10', marginTop: 4, lineHeight: 1.25 }}>{s.name || '—'}</h3>
          <div data-model-sizes style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
            {s.sizes.map((z) => (
              <span key={'a' + z.size} className="font-mono" title="available"
                style={{ fontSize: 11, padding: '2px 7px', borderRadius: 6, border: '1px solid rgba(126,170,110,0.55)', background: 'rgba(126,170,110,0.13)', color: '#0F0F10' }}>
                <b>{z.size}</b> ×{z.count}
              </span>
            ))}
            {s.soldSizes.map((z) => (
              <span key={'s' + z} className="font-mono" title="sold / not available — not counted as stock"
                style={{ fontSize: 11, padding: '2px 7px', borderRadius: 6, border: '1px solid #D5D9DE', background: '#FAFBFC', color: '#6B7280', textDecoration: 'line-through' }}>
                {z}
              </span>
            ))}
          </div>
          <div className="flex items-center justify-between" style={{ marginTop: 14, gap: 8, fontSize: 12 }}>
            <span style={{ color: '#4B5563' }}>
              Sale <span className="font-mono" style={{ color: '#0F0F10' }}>
                {s.priceMin == null ? '—' : s.priceMin === s.priceMax ? <Bhd v={s.priceMin} /> : <><Bhd v={s.priceMin} /> – <Bhd v={s.priceMax ?? s.priceMin} /></>}
              </span>
            </span>
            <span style={{ color: '#4B5563' }} data-model-counts>
              <b style={{ color: '#0F0F10' }}>{s.available.length}</b> available{s.sold ? <span style={{ color: '#6B7280' }}> · {s.sold} sold</span> : null}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
