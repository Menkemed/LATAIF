// ARTIKELVARIANTEN — der Abschnitt „Model" auf der Artikelseite: alle Varianten mit SKU, Größe, Gewicht, Preis und Status
// (verkaufte bleiben sichtbar), Einzelartikel direkt öffnen, dazu Add variant / Merge photos / Edit group. Ohne Modell:
// „Mit anderen Artikeln gruppieren". Jede Variante bleibt ein eigener Artikel mit eigener Buchhaltung.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { StatusDot } from '@/components/ui/StatusDot';
import { CollectionProductThumb } from '@/components/products/CollectionProductThumb';
import { usePermission } from '@/hooks/usePermission';
import { useProductStore } from '@/stores/productStore';
import { isSystemArticle, mayJoinModel } from '@/core/products/product-models';
import { descriptionOf, karatOf, modelMembers, modelTitle, shortText, sizeOf, summarizeModel, weightOf } from '@/core/products/product-models-view';
import type { Product } from '@/core/models/types';
import { GroupItemsModal } from './GroupItemsModal';
import { EditGroupModal } from './EditGroupModal';
import { MergePhotosModal } from './MergePhotosModal';

interface Props {
  product: Product;
  tenantId: string | undefined;
  branchId: string | undefined;
  /** nach „Merge Photos": die Bilder der offenen Seite neu laden */
  onMediaChanged?: () => void;
}

export function ModelSection({ product, tenantId, branchId, onMediaChanged }: Props) {
  const navigate = useNavigate();
  const perm = usePermission();
  const { products, productModels } = useProductStore();
  const [groupOpen, setGroupOpen] = useState<null | { target: string | null; initial: string[] }>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const key = productModels[product.id];
  const members = key ? modelMembers(products, productModels, key) : [];
  const canEdit = perm.canEditProducts;

  if (!key || members.length < 2) {
    if (!canEdit || isSystemArticle(product.id, product.categoryId || '') || !mayJoinModel(String(product.stockStatus))) return null;
    return (
      <Card style={{ marginBottom: 32, padding: '14px 18px' }}>
        <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }} data-model-section="none">
          <span style={{ fontSize: 13, color: '#4B5563', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Layers size={14} /> This item is not part of a model.
          </span>
          <div className="flex items-center gap-2">
            {/* PURCHASE ADD VARIANT — auch ohne Modell: beim Speichern entsteht das Modell aus diesem Artikel und der Variante.
                Nur Eigenware (eine Kommissions-Variante entsteht nur über die Kommissionsaufnahme). */}
            {String(product.sourceType || 'OWN').toUpperCase() === 'OWN' && (
              <Button variant="primary" onClick={() => navigate(`/collection?variantOf=${encodeURIComponent(product.id)}`)} data-model-add-variant>+ Add variant</Button>
            )}
            <Button variant="ghost" onClick={() => setGroupOpen({ target: null, initial: [product.id] })} data-model-group-with>Group with other items</Button>
          </div>
        </div>
        <GroupItemsModal open={!!groupOpen} onClose={() => setGroupOpen(null)} initialSelection={groupOpen?.initial} targetKey={groupOpen?.target ?? null} />
      </Card>
    );
  }

  const s = summarizeModel(key, members);
  return (
    <Card style={{ marginBottom: 32, padding: 0, overflow: 'hidden' }}>
      <div data-model-section={key} style={{ padding: '16px 20px', borderBottom: '1px solid #E5E9EE', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="text-overline" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Layers size={12} /> MODEL</span>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#0F0F10' }}>{modelTitle(s)} · {s.members.length} items</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {s.sizes.map((z) => (
              <span key={z.size} className="font-mono" style={{ fontSize: 11, padding: '2px 7px', borderRadius: 6, border: '1px solid rgba(126,170,110,0.55)', background: 'rgba(126,170,110,0.13)' }}><b>{z.size}</b> ×{z.count}</span>
            ))}
            {s.soldSizes.map((z) => (
              <span key={'s' + z} className="font-mono" style={{ fontSize: 11, padding: '2px 7px', borderRadius: 6, border: '1px solid #D5D9DE', color: '#6B7280', textDecoration: 'line-through' }}>{z}</span>
            ))}
          </div>
          <span style={{ fontSize: 12, color: '#6B7280' }}>{s.available.length} available · {s.sold} sold{s.other ? ` · ${s.other} reserved/other` : ''}</span>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
            {/* „Add variant" legt über „New Item" EIGENE Ware an — ein Kommissionsmodell wächst nur über die Kommissionsaufnahme. */}
            {!s.members.some((m) => m.sourceType === 'CONSIGNMENT') && (
              <Button variant="primary" onClick={() => navigate(`/collection?variantOf=${encodeURIComponent(product.id)}`)} data-model-add-variant>+ Add variant</Button>
            )}
            <Button variant="ghost" onClick={() => setMergeOpen(true)} data-model-merge-photos>Merge photos</Button>
            <Button variant="ghost" onClick={() => setEditOpen(true)} data-model-edit-group>Edit group</Button>
          </div>
        )}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ background: '#FAFBFC', color: '#6B7280', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            <th style={{ padding: '8px 12px' }} /><th style={{ padding: 8, textAlign: 'left' }}>SKU</th><th style={{ padding: 8, textAlign: 'left' }}>Size</th><th style={{ padding: 8, textAlign: 'left' }}>Karat &amp; Color</th><th style={{ padding: 8, textAlign: 'left' }}>Description</th>
            <th style={{ padding: 8, textAlign: 'right' }}>Weight</th><th style={{ padding: 8, textAlign: 'right' }}>Sale</th><th style={{ padding: 8, textAlign: 'right' }}>Min</th>
            <th style={{ padding: 8, textAlign: 'left' }}>Status</th><th style={{ padding: 8, textAlign: 'left' }}>Ownership</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} data-model-variant={m.id} tabIndex={0}
              onClick={() => { if (m.id !== product.id) navigate(`/collection/${m.id}`); }}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && m.id !== product.id) { e.preventDefault(); navigate(`/collection/${m.id}`); } }}
              className="cursor-pointer"
              style={{ borderTop: '1px solid #E5E9EE', background: m.id === product.id ? 'rgba(113,93,227,0.07)' : undefined, color: String(m.stockStatus).toLowerCase() === 'sold' ? '#6B7280' : '#0F0F10' }}>
              <td style={{ padding: '6px 12px', width: 56 }}>
                <div style={{ width: 44, height: 33, borderRadius: 6, overflow: 'hidden', border: '1px solid #E5E9EE', background: '#F2F7FA', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CollectionProductThumb product={m} tenantId={tenantId} branchId={branchId} iconSize={14} />
                </div>
              </td>
              <td className="font-mono" style={{ padding: 8, whiteSpace: 'nowrap' }}>{m.sku || '—'}{m.id === product.id ? <span style={{ marginLeft: 6, fontSize: 10, color: '#5B3DCC' }}>this item</span> : null}</td>
              <td style={{ padding: 8 }}>{sizeOf(m) || '—'}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }} data-model-row-karat>{karatOf(m) || '—'}</td>
              <td style={{ padding: 8, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={descriptionOf(m) || undefined} data-model-row-description>{descriptionOf(m) ? shortText(descriptionOf(m), 40) : '—'}</td>
              <td className="font-mono" style={{ padding: 8, textAlign: 'right' }}>{weightOf(m) != null ? `${weightOf(m)!.toFixed(2)} g` : '—'}</td>
              <td className="font-mono" style={{ padding: 8, textAlign: 'right' }}>{m.plannedSalePrice ? <Bhd v={m.plannedSalePrice} /> : '—'}</td>
              <td className="font-mono" style={{ padding: 8, textAlign: 'right' }}>{m.minSalePrice ? <Bhd v={m.minSalePrice} /> : '—'}</td>
              <td style={{ padding: 8 }}><StatusDot status={m.stockStatus} /></td>
              <td style={{ padding: 8 }}>{m.sourceType === 'CONSIGNMENT' ? 'Consignment' : 'Own'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: '8px 16px', fontSize: 11, color: '#6B7280', borderTop: '1px solid #E5E9EE' }}>
        Click a row to open that item. Each item keeps its own SKU, cost, stock and bookings; sold items stay visible and are not counted as stock.
      </div>
      <GroupItemsModal open={!!groupOpen} onClose={() => setGroupOpen(null)} initialSelection={groupOpen?.initial} targetKey={groupOpen?.target ?? null} />
      <EditGroupModal open={editOpen} modelKey={key} onClose={() => setEditOpen(false)} onAddItems={() => { setEditOpen(false); setGroupOpen({ target: key, initial: [] }); }} />
      <MergePhotosModal open={mergeOpen} modelKey={key} tenantId={tenantId} branchId={branchId} onClose={() => setMergeOpen(false)} onChanged={onMediaChanged} />
    </Card>
  );
}
