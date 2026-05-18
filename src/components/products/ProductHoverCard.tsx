// ProductHoverCard — kompakte Detail-Karte fuer Produktauswahlen
// (z.B. Production Input-Picker, Invoice-Line-Picker). Zeigt Foto,
// Brand/Name, Kategorie, SKU/Reference, Condition und kategorie-
// spezifische Attribute (Material, Karat, Gewicht, Color, ...) plus
// Cost — damit User auf einen Blick erkennt welches Produkt das ist
// ohne es oeffnen zu muessen.
import { useMemo } from 'react';
import { Bhd } from '@/components/ui/Bhd';
import { getProductSpecs } from '@/core/utils/product-format';
import type { Product, Category } from '@/core/models/types';

interface ProductHoverCardProps {
  product: Product | undefined;
  categories: Category[];
}

export function ProductHoverCard({ product, categories }: ProductHoverCardProps) {
  const specs = useMemo(
    () => getProductSpecs(product, categories, { prominentOnly: false, includeSku: false, includeCondition: false }),
    [product, categories]
  );
  if (!product) return null;
  const cat = categories.find(c => c.id === product.categoryId);
  const cover = (product.images || [])[0];
  const titleLine = `${product.brand || ''} ${product.name || ''}`.trim() || '(unnamed)';

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
      {/* Cover Photo */}
      {cover ? (
        <div style={{ width: '100%', height: 160, background: '#F2F7FA', overflow: 'hidden' }}>
          <img
            src={cover}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
      ) : (
        <div style={{
          width: '100%', height: 80, background: '#F2F7FA',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: '#9CA3AF',
        }}>
          No image
        </div>
      )}

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
          <span className="font-mono" style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>
            <Bhd v={product.purchasePrice} /> BHD
          </span>
        </div>

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
