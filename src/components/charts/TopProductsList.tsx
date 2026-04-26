// Plan §Design v2 — Top Products Liste wie Image #18.
// Saubere Listen-Items mit Bild, Name, Subtitle, Preis rechts.
import { useNavigate } from 'react-router-dom';
import { Package } from 'lucide-react';

export interface TopProductItem {
  id: string;
  name: string;
  subtitle?: string;
  price: number;
  imageUrl?: string;
  unit?: string;
}

interface TopProductsListProps {
  items: TopProductItem[];
  title?: string;
  formatPrice?: (v: number) => string;
  emptyText?: string;
}

export function TopProductsList({
  items,
  title = 'Top Products',
  formatPrice = (v) => `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} BHD`,
  emptyText = 'No data yet.',
}: TopProductsListProps) {
  const navigate = useNavigate();

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 16, border: '1px solid #E5E9EE', padding: 18 }}>
      <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10' }}>{title}</span>
        <button
          onClick={() => navigate('/collection')}
          style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 18, cursor: 'pointer' }}
        >…</button>
      </div>

      {items.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: '#9CA3AF' }}>{emptyText}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map(item => (
            <div
              key={item.id}
              className="cursor-pointer transition-colors"
              style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '10px 12px', borderRadius: 12,
                background: '#F8FAFC',
              }}
              onClick={() => navigate(`/collection/${item.id}`)}
              onMouseEnter={e => (e.currentTarget.style.background = '#EEF2F8')}
              onMouseLeave={e => (e.currentTarget.style.background = '#F8FAFC')}
            >
              {/* Product Image / Icon */}
              <div style={{
                width: 44, height: 44, borderRadius: 10,
                background: '#FFFFFF', border: '1px solid #E5E9EE',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden', flexShrink: 0,
              }}>
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <Package size={18} strokeWidth={1.5} style={{ color: '#9CA3AF' }} />
                )}
              </div>

              {/* Name + Subtitle */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </div>
                {item.subtitle && (
                  <div style={{ fontSize: 11, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                    {item.subtitle}
                  </div>
                )}
              </div>

              {/* Price */}
              <div style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10', flexShrink: 0 }}>
                {formatPrice(item.price)}{item.unit && <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 2 }}>{item.unit}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
