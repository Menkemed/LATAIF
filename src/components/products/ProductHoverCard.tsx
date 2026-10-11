// ProductHoverCard — kompakte Detail-Karte fuer Produktauswahlen
// (z.B. Production Input-Picker, Invoice-Line-Picker). Zeigt Foto,
// Brand/Name, Kategorie, SKU/Reference, Condition und kategorie-
// spezifische Attribute (Material, Karat, Gewicht, Color, ...) plus
// Cost — damit User auf einen Blick erkennt welches Produkt das ist
// ohne es oeffnen zu muessen.
import { useMemo } from 'react';
import { Bhd } from '@/components/ui/Bhd';
import { getProductSpecs } from '@/core/utils/product-format';
import { CollectionProductThumb } from '@/components/products/CollectionProductThumb';
import { useMediaScope } from '@/hooks/useMediaScope';
import type { Product, Category } from '@/core/models/types';
import { productDisplayName } from '@/core/products/display-name';
// Der Einstand kommt aus den Losen — dieselbe Kernauskunft wie die Artikelseite (`product.lots.get`),
// am Primary lokal, an PC2 vom Primary. `fifoCost` ist der Wert, den ein Verkauf als Einstand bucht.
import { useSharedRead } from '@/core/data/shared-read';
import { productLotsFor, type ProductLots } from '@/core/data/domain-reads';
import { hoverCardCost } from '@/core/products/hover-cost';

/** „Noch nicht da" (nur an PC2, solange die Antwort des Primary aussteht) — nie ein Einstand. */
const LOSE_LADEN: ProductLots = { lots: [], fifo: null };

interface ProductHoverCardProps {
  product: Product | undefined;
  categories: Category[];
}

export function ProductHoverCard({ product, categories }: ProductHoverCardProps) {
  const specs = useMemo(
    () => getProductSpecs(product, categories, { prominentOnly: false, includeSku: false, includeCondition: false }),
    [product, categories]
  );
  const { tenantId: mediaTenantId, branchId: mediaBranchId } = useMediaScope();
  const productId = product?.id ?? '';
  const lose = useSharedRead('product.lots.get', { productId }, (ctx) => productLotsFor(ctx, productId), LOSE_LADEN, [productId]);
  if (!product) return null;
  const laedt = lose === LOSE_LADEN;
  const cost = hoverCardCost(product.purchasePrice, laedt ? null : lose.fifo);
  const cat = categories.find(c => c.id === product.categoryId);
  const titleLine = productDisplayName(product) || '(unnamed)';

  return (
    <div
      style={{
        width: 320,
        background: '#FFFFFF',
        border: '1px solid #E5E9EE',
        borderRadius: 10,
        boxShadow: '0 12px 36px rgba(15,15,16,0.20)',
        overflow: 'hidden',
      }}
    >
      {/* Cover Photo — v0.7.18: `contain` damit das volle Foto sichtbar bleibt
          (vorher schnitt `cover` die Raender ab). */}
      <div style={{
        width: '100%', height: 160, background: '#F2F7FA', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <CollectionProductThumb
          product={product}
          tenantId={mediaTenantId}
          branchId={mediaBranchId}
          imgStyle={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          iconSize={40}
          iconColor="#9CA3AF"
        />
      </div>

      <div style={{ padding: 12 }}>
        {/* Category + SKU */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, minHeight: 14 }}>
          {cat && (
            <span style={{
              fontSize: 9, fontWeight: 600, color: '#6B7280',
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>{cat.name}</span>
          )}
          {product.sku && (
            <span className="font-mono" style={{ fontSize: 10, color: '#9CA3AF' }}>{product.sku}</span>
          )}
        </div>

        {/* Brand + Name */}
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10', marginBottom: 8, lineHeight: 1.25 }}>
          {titleLine}
        </div>

        {/* Condition Pill */}
        {product.condition && (
          <div style={{ marginBottom: 8 }}>
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 999,
              background: '#F2F7FA', color: '#4B5563', border: '1px solid #E5E9EE',
            }}>
              {product.condition}
            </span>
          </div>
        )}

        {/* Specs Grid */}
        {specs.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px',
            borderTop: '1px solid #F0F2F5', paddingTop: 8, marginBottom: 8,
          }}>
            {specs.map((s, i) => (
              <div key={i} style={{ fontSize: 11, lineHeight: 1.4, minWidth: 0 }}>
                <div style={{ color: '#9CA3AF', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {s.label}
                </div>
                <div style={{
                  color: '#0F0F10', fontWeight: 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Cost */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderTop: '1px solid #F0F2F5', paddingTop: 8,
        }}>
          <span style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Cost
          </span>
          <span data-hover-cost={laedt ? 'loading' : cost.source} className="font-mono" style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>
            {laedt ? '…' : <><Bhd v={cost.value} /> BHD</>}
          </span>
        </div>
        {!laedt && cost.lots && (
          <div data-hover-cost-lots style={{ fontSize: 10, color: '#6B7280', textAlign: 'right', marginTop: 2 }}>
            avg <Bhd v={cost.avg ?? 0} /> BHD · {cost.lots} lots
          </div>
        )}

        {/* Storage Location (falls vorhanden) */}
        {product.storageLocation && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: 4,
          }}>
            <span style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Location
            </span>
            <span style={{ fontSize: 11, color: '#4B5563' }}>{product.storageLocation}</span>
          </div>
        )}
      </div>
    </div>
  );
}
