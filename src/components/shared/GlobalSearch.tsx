import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Package, Users, FileText, Receipt, Wrench, ShoppingCart,
  Truck, RotateCcw, Banknote, CircleDollarSign, Hammer, X,
} from 'lucide-react';
// CENTRAL-UI-PARITY R2D — die Suche liegt im gemeinsamen Modul.
import { useSharedRead } from '@/core/data/shared-read';
import { globalSearchFor } from '@/core/search/global-search';

type ResultType =
  | 'product' | 'customer' | 'offer' | 'invoice' | 'repair' | 'order'
  | 'purchase' | 'sales_return' | 'purchase_return' | 'expense' | 'production';

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  subtitle: string;
  link: string;
  date?: string;
  amount?: number;
}

const typeIcons: Record<ResultType, typeof Package> = {
  product: Package,
  customer: Users,
  offer: FileText,
  invoice: Receipt,
  repair: Wrench,
  order: ShoppingCart,
  purchase: Truck,
  sales_return: RotateCcw,
  purchase_return: RotateCcw,
  expense: Banknote,
  production: Hammer,
};

const typeColors: Record<ResultType, string> = {
  product: '#0F0F10',
  customer: '#6E8AAA',
  offer: '#AA956E',
  invoice: '#7EAA6E',
  repair: '#AA956E',
  order: '#A76ECF',
  purchase: '#B77B3A',
  sales_return: '#D17060',
  purchase_return: '#D17060',
  expense: '#6B7280',
  production: '#7B4AAA',
};


type FilterKey = 'all' | 'products' | 'customers' | 'documents' | 'sold';

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'products', label: 'Products' },
  { key: 'customers', label: 'Customers' },
  { key: 'documents', label: 'Documents' },
  { key: 'sold', label: 'Sold items' },
];

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [weightMin, setWeightMin] = useState('');
  const [weightMax, setWeightMax] = useState('');
  const [productStatus, setProductStatus] = useState<string>(''); // '' | in_stock | sold | with_agent | in_repair
  const [showAdvanced, setShowAdvanced] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // CENTRAL-UI-PARITY R2D — die Suche selbst steht in einer gemeinsamen Ladefunktion. Sie
  // bekommt NUR, was der Mensch eingegeben hat; welche Tabellen befragt werden und fuer welche
  // Filiale, entscheidet sie selbst aus dem Ausweis der Anfrage.
  const suchParams = useMemo(() => ({
    q, filter, dateFrom, dateTo, amountMin, amountMax, weightMin, weightMax, productStatus,
  }), [q, filter, dateFrom, dateTo, amountMin, amountMax, weightMin, weightMax, productStatus]);
  const treffer = useSharedRead('search.global.get', suchParams, (ctx) => globalSearchFor(ctx, suchParams),
    { items: [] as SearchResult[] }, [suchParams]);
  const results = treffer.items;

  const handleSelect = useCallback((result: SearchResult) => {
    navigate(result.link);
    setOpen(false);
    setQ('');
  }, [navigate]);

  const resetFilters = () => {
    setDateFrom(''); setDateTo(''); setAmountMin(''); setAmountMax('');
    setWeightMin(''); setWeightMax(''); setProductStatus(''); setFilter('all');
  };

  if (!open) return null;

  const hasFilters = dateFrom || dateTo || amountMin || amountMax || weightMin || weightMax || productStatus || filter !== 'all';

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center" style={{ paddingTop: 80 }}>
      <div className="absolute inset-0" style={{ background: 'rgba(15,15,16,0.35)', backdropFilter: 'blur(4px)' }} onClick={() => setOpen(false)} />
      <div className="relative animate-fade-in" style={{ width: 640, background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12, overflow: 'hidden' }}>
        <div className="flex items-center gap-3" style={{ padding: '16px 20px', borderBottom: '1px solid #E5E9EE' }}>
          <Search size={18} style={{ color: '#6B7280' }} />
          <input
            autoFocus
            placeholder="Search products, clients, invoices, or type INV-2026-001…"
            value={q}
            onChange={e => setQ(e.target.value)}
            className="flex-1 outline-none"
            style={{ background: 'transparent', border: 'none', fontSize: 15, color: '#0F0F10' }}
          />
          <button
            onClick={() => setShowAdvanced(v => !v)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              border: '1px solid ' + (showAdvanced || hasFilters ? '#0F0F10' : '#D5D9DE'),
              background: showAdvanced || hasFilters ? '#0F0F10' : 'transparent',
              color: showAdvanced || hasFilters ? '#FFFFFF' : '#6B7280',
            }}
          >Filters</button>
          <span style={{ fontSize: 11, color: '#6B7280', padding: '2px 6px', border: '1px solid #D5D9DE', borderRadius: 4 }}>ESC</span>
        </div>

        <div className="flex items-center gap-2" style={{ padding: '10px 20px', borderBottom: '1px solid #E5E9EE', flexWrap: 'wrap' }}>
          {FILTER_CHIPS.map(chip => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                border: '1px solid ' + (filter === chip.key ? '#0F0F10' : '#D5D9DE'),
                background: filter === chip.key ? '#0F0F10' : 'transparent',
                color: filter === chip.key ? '#FFFFFF' : '#4B5563',
              }}
            >{chip.label}</button>
          ))}
          {hasFilters && (
            <button onClick={resetFilters} style={{ fontSize: 11, color: '#6B7280', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <X size={12} /> Clear
            </button>
          )}
        </div>

        {showAdvanced && (
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #E5E9EE', background: '#F7F5EE', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Date from</span>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Date to</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}><CircleDollarSign size={11} style={{ display: 'inline', marginRight: 3 }} />Min amount (BHD)</span>
              <input type="number" step="0.001" value={amountMin} onChange={e => setAmountMin(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}><CircleDollarSign size={11} style={{ display: 'inline', marginRight: 3 }} />Max amount (BHD)</span>
              <input type="number" step="0.001" value={amountMax} onChange={e => setAmountMax(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Min weight (g)</span>
              <input type="number" step="0.01" value={weightMin} onChange={e => setWeightMin(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Max weight (g)</span>
              <input type="number" step="0.01" value={weightMax} onChange={e => setWeightMax(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: 'span 2' }}>
              <span style={{ color: '#6B7280' }}>Product status</span>
              <select value={productStatus} onChange={e => setProductStatus(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 12, background: '#FFFFFF' }}>
                <option value="">Any</option>
                <option value="in_stock">IN_STOCK</option>
                <option value="reserved">RESERVED</option>
                <option value="sold">SOLD</option>
                <option value="with_agent">GIVEN_TO_AGENT</option>
                <option value="in_repair">UNDER_REPAIR</option>
                <option value="returned">RETURNED</option>
              </select>
            </label>
          </div>
        )}

        {results.length > 0 && (
          <div style={{ maxHeight: 440, overflowY: 'auto', padding: '8px' }}>
            {results.map(r => {
              const Icon = typeIcons[r.type] || Package;
              return (
                <div key={`${r.type}-${r.id}`}
                  className="flex items-center gap-3 cursor-pointer rounded-lg transition-colors"
                  style={{ padding: '10px 12px' }}
                  onClick={() => handleSelect(r)}
                  onMouseEnter={e => (e.currentTarget.style.background = '#E5E9EE')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <Icon size={16} style={{ color: typeColors[r.type], flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 14, color: '#0F0F10', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
                    {r.subtitle && <div style={{ fontSize: 11, color: '#6B7280' }}>{r.subtitle}</div>}
                  </div>
                  {r.amount !== undefined && (
                    <div style={{ fontSize: 12, color: '#4B5563', fontVariantNumeric: 'tabular-nums' }}>
                      {r.amount.toFixed(3)} BHD
                    </div>
                  )}
                  <span style={{ fontSize: 10, color: typeColors[r.type], padding: '2px 8px', borderRadius: 999, background: typeColors[r.type] + '15', whiteSpace: 'nowrap' }}>
                    {r.type.replace('_', ' ')}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {q.length >= 2 && results.length === 0 && (
          <div style={{ padding: '32px 20px', textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: '#6B7280' }}>No results for "{q}"</p>
            {hasFilters && <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>Try clearing your filters</p>}
          </div>
        )}

        {q.length < 2 && (
          <div style={{ padding: '20px 20px', textAlign: 'center' }}>
            <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 4 }}>Type at least 2 characters</p>
            <p style={{ fontSize: 11, color: '#9CA3AF' }}>
              Tip: type a document prefix (INV, PUR, REP, OFF…) to jump directly
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
