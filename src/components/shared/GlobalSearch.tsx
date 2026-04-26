import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Package, Users, FileText, Receipt, Wrench, ShoppingCart,
  Truck, RotateCcw, Banknote, CircleDollarSign, Hammer, X,
} from 'lucide-react';
import { query, currentBranchId } from '@/core/db/helpers';

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

// Document prefix → destination
const DOC_PREFIX_MAP: { prefix: string; type: ResultType; table: string; numberCol: string; linkFn: (id: string) => string; hasDetail: boolean }[] = [
  { prefix: 'PINV', type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'INV',  type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'OFF',  type: 'offer', table: 'offers', numberCol: 'offer_number', linkFn: (id) => `/offers/${id}`, hasDetail: true },
  { prefix: 'PUR',  type: 'purchase', table: 'purchases', numberCol: 'purchase_number', linkFn: (id) => `/purchases/${id}`, hasDetail: true },
  { prefix: 'PRET', type: 'purchase_return', table: 'purchase_returns', numberCol: 'return_number', linkFn: () => `/purchases`, hasDetail: false },
  { prefix: 'RET',  type: 'sales_return', table: 'sales_returns', numberCol: 'return_number', linkFn: () => `/invoices`, hasDetail: false },
  { prefix: 'REP',  type: 'repair', table: 'repairs', numberCol: 'repair_number', linkFn: (id) => `/repairs/${id}`, hasDetail: true },
  { prefix: 'AGD',  type: 'order', table: 'agent_transfers', numberCol: 'transfer_number', linkFn: () => `/agents`, hasDetail: false },
  { prefix: 'CON',  type: 'order', table: 'consignments', numberCol: 'consignment_number', linkFn: (id) => `/consignments/${id}`, hasDetail: true },
  { prefix: 'EXP',  type: 'expense', table: 'expenses', numberCol: 'expense_number', linkFn: () => `/expenses`, hasDetail: false },
  { prefix: 'PRD',  type: 'production', table: 'production_records', numberCol: 'production_number', linkFn: () => `/production`, hasDetail: false },
];

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

  const results = useMemo((): SearchResult[] => {
    if (!q || q.length < 2) return [];
    const term = `%${q}%`;
    const items: SearchResult[] = [];
    let branchId: string;
    try { branchId = currentBranchId(); } catch { return []; }

    const trimmed = q.trim().toUpperCase();
    const matchedPrefix = DOC_PREFIX_MAP.find(p => trimmed.startsWith(p.prefix + '-') || trimmed.startsWith(p.prefix + ' '));

    const minAmount = amountMin ? parseFloat(amountMin) : null;
    const maxAmount = amountMax ? parseFloat(amountMax) : null;
    const minWeight = weightMin ? parseFloat(weightMin) : null;
    const maxWeight = weightMax ? parseFloat(weightMax) : null;

    // Plan §Search §11: Smart search — reine Zahl als Preis deuten, "Xg" / "X g" als Gewicht.
    const asNumber = /^-?\d+(\.\d+)?$/.test(q.trim()) ? parseFloat(q.trim()) : null;
    const weightMatch = q.trim().match(/^(\d+(?:\.\d+)?)\s*g(?:r|ram|rams)?$/i);
    const smartWeight = weightMatch ? parseFloat(weightMatch[1]) : null;

    try {
      // ── Document-ID direct routing (highest priority) ──
      if (matchedPrefix && (filter === 'all' || filter === 'documents')) {
        const rows = query(
          `SELECT id, ${matchedPrefix.numberCol} AS num FROM ${matchedPrefix.table}
           WHERE branch_id = ? AND ${matchedPrefix.numberCol} LIKE ? LIMIT 8`,
          [branchId, term]
        );
        for (const r of rows) {
          items.push({
            type: matchedPrefix.type,
            id: r.id as string,
            title: r.num as string,
            subtitle: matchedPrefix.hasDetail ? 'Open document' : `Open ${matchedPrefix.type} list`,
            link: matchedPrefix.linkFn(r.id as string),
          });
        }
        if (items.length > 0) return items;
      }

      // ── Products ── (Plan §Search §3-5: brand/serial/model/category/weight/price/material + status)
      if (filter === 'all' || filter === 'products' || filter === 'sold') {
        // Smart Search: reine Zahl → Preisbereich ±10% um Zahl
        const priceMin = asNumber !== null ? asNumber * 0.9 : minAmount;
        const priceMax = asNumber !== null ? asNumber * 1.1 : maxAmount;
        const effWeightMin = smartWeight !== null ? smartWeight * 0.9 : minWeight;
        const effWeightMax = smartWeight !== null ? smartWeight * 1.1 : maxWeight;

        const whereParts: string[] = [`branch_id = ?`];
        const args: unknown[] = [branchId];
        // Text-Suche nur wenn kein reiner Zahlen-/Gewichts-Input
        if (asNumber === null && smartWeight === null) {
          whereParts.push(`(brand LIKE ? OR name LIKE ? OR sku LIKE ? OR notes LIKE ?)`);
          args.push(term, term, term, term);
        }
        if (priceMin !== null) { whereParts.push(`(retail_price >= ? OR purchase_price >= ?)`); args.push(priceMin, priceMin); }
        if (priceMax !== null) { whereParts.push(`(retail_price <= ? OR purchase_price <= ?)`); args.push(priceMax, priceMax); }
        if (productStatus) { whereParts.push(`stock_status = ?`); args.push(productStatus); }

        const prods = query(
          `SELECT id, brand, name, sku, retail_price, status, stock_status, attributes
           FROM products WHERE ${whereParts.join(' AND ')} LIMIT 20`,
          args
        );

        // Weight-Filter läuft client-seitig auf JSON attributes
        const filtered = prods.filter(p => {
          if (effWeightMin === null && effWeightMax === null) return true;
          try {
            const attr = JSON.parse((p.attributes as string) || '{}');
            const w = parseFloat(String(attr.weight || attr.Weight || ''));
            if (!isFinite(w)) return false;
            if (effWeightMin !== null && w < effWeightMin) return false;
            if (effWeightMax !== null && w > effWeightMax) return false;
            return true;
          } catch { return false; }
        });
        prods.length = 0;
        prods.push(...filtered.slice(0, 8));
        for (const p of prods) {
          // Check if sold — look up invoice_lines
          const soldRows = query(
            `SELECT i.id AS inv_id, i.invoice_number, i.issued_at, i.status, c.first_name, c.last_name, c.company
             FROM invoice_lines il
             JOIN invoices i ON i.id = il.invoice_id
             LEFT JOIN customers c ON c.id = i.customer_id
             WHERE il.product_id = ? AND i.status != 'CANCELLED'
             ORDER BY i.issued_at DESC LIMIT 1`,
            [p.id]
          );
          const isSold = soldRows.length > 0;
          if (filter === 'sold' && !isSold) continue;

          if (isSold) {
            const s = soldRows[0];
            const customerName = (s.company as string) || `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown';
            items.push({
              type: 'product',
              id: p.id as string,
              title: `${p.brand} ${p.name}`,
              subtitle: `Sold · ${s.invoice_number} · ${customerName}`,
              link: `/invoices/${s.inv_id}`,
              date: s.issued_at as string,
            });
          } else {
            items.push({
              type: 'product',
              id: p.id as string,
              title: `${p.brand} ${p.name}`,
              subtitle: (p.sku as string) || (p.status as string) || '',
              link: `/collection/${p.id}`,
            });
          }
        }
      }

      // ── Customers ──
      if (filter === 'all' || filter === 'customers') {
        const custs = query(
          `SELECT id, first_name, last_name, company, phone, email FROM customers
           WHERE branch_id = ? AND (first_name LIKE ? OR last_name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?)
           LIMIT 6`,
          [branchId, term, term, term, term, term]
        );
        for (const c of custs) {
          items.push({
            type: 'customer',
            id: c.id as string,
            title: `${c.first_name} ${c.last_name}`.trim(),
            subtitle: (c.company as string) || (c.email as string) || (c.phone as string) || '',
            link: `/clients/${c.id}`,
          });
        }
      }

      // ── Documents (numbers + cross-doc search) ──
      if (filter === 'all' || filter === 'documents') {
        const dateFilter = (col: string) => {
          const parts: string[] = [];
          const args: unknown[] = [];
          if (dateFrom) { parts.push(`${col} >= ?`); args.push(dateFrom); }
          if (dateTo)   { parts.push(`${col} <= ?`); args.push(dateTo + 'T23:59:59'); }
          return { where: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
        };
        const amountFilter = (col: string) => {
          const parts: string[] = [];
          const args: unknown[] = [];
          if (minAmount !== null) { parts.push(`${col} >= ?`); args.push(minAmount); }
          if (maxAmount !== null) { parts.push(`${col} <= ?`); args.push(maxAmount); }
          return { where: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
        };

        // Offers
        const offD = dateFilter('o.created_at');
        const offA = amountFilter('o.total');
        const offs = query(
          `SELECT o.id, o.offer_number, o.total, o.created_at, c.first_name, c.last_name, c.company
           FROM offers o LEFT JOIN customers c ON c.id = o.customer_id
           WHERE o.branch_id = ? AND o.offer_number LIKE ?${offD.where}${offA.where} LIMIT 4`,
          [branchId, term, ...offD.args, ...offA.args]
        );
        for (const o of offs) {
          const cust = (o.company as string) || `${o.first_name || ''} ${o.last_name || ''}`.trim();
          items.push({
            type: 'offer',
            id: o.id as string,
            title: o.offer_number as string,
            subtitle: cust ? `Offer · ${cust}` : 'Offer',
            link: `/offers/${o.id}`,
            amount: o.total as number,
            date: o.created_at as string,
          });
        }

        // Invoices
        const invD = dateFilter('i.issued_at');
        const invA = amountFilter('i.gross_amount');
        const invs = query(
          `SELECT i.id, i.invoice_number, i.gross_amount, i.issued_at, i.status, c.first_name, c.last_name, c.company
           FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
           WHERE i.branch_id = ? AND i.invoice_number LIKE ?${invD.where}${invA.where} LIMIT 4`,
          [branchId, term, ...invD.args, ...invA.args]
        );
        for (const i of invs) {
          const cust = (i.company as string) || `${i.first_name || ''} ${i.last_name || ''}`.trim();
          items.push({
            type: 'invoice',
            id: i.id as string,
            title: i.invoice_number as string,
            subtitle: `${i.status || 'Invoice'}${cust ? ' · ' + cust : ''}`,
            link: `/invoices/${i.id}`,
            amount: i.gross_amount as number,
            date: i.issued_at as string,
          });
        }

        // Purchases
        const purD = dateFilter('created_at');
        const purA = amountFilter('gross_amount');
        const purs = query(
          `SELECT id, purchase_number, gross_amount, created_at, status
           FROM purchases WHERE branch_id = ? AND purchase_number LIKE ?${purD.where}${purA.where} LIMIT 3`,
          [branchId, term, ...purD.args, ...purA.args]
        );
        for (const p of purs) {
          items.push({
            type: 'purchase',
            id: p.id as string,
            title: p.purchase_number as string,
            subtitle: `Purchase · ${p.status || ''}`,
            link: `/purchases/${p.id}`,
            amount: p.gross_amount as number,
            date: p.created_at as string,
          });
        }

        // Repairs
        const reps = query(
          `SELECT id, repair_number, voucher_code, created_at FROM repairs
           WHERE branch_id = ? AND (repair_number LIKE ? OR voucher_code LIKE ?)${dateFilter('created_at').where} LIMIT 3`,
          [branchId, term, term, ...dateFilter('created_at').args]
        );
        for (const r of reps) {
          items.push({
            type: 'repair',
            id: r.id as string,
            title: r.repair_number as string,
            subtitle: r.voucher_code ? `Voucher: ${r.voucher_code}` : 'Repair',
            link: `/repairs/${r.id}`,
            date: r.created_at as string,
          });
        }

        // Orders
        const ordrs = query(
          `SELECT id, order_number, agreed_price, created_at, status FROM orders
           WHERE branch_id = ? AND order_number LIKE ?${dateFilter('created_at').where} LIMIT 3`,
          [branchId, term, ...dateFilter('created_at').args]
        );
        for (const o of ordrs) {
          items.push({
            type: 'order',
            id: o.id as string,
            title: o.order_number as string,
            subtitle: `Order · ${o.status || ''}`,
            link: `/orders/${o.id}`,
            amount: o.agreed_price as number,
            date: o.created_at as string,
          });
        }
      }
    } catch (e) {
      console.warn('GlobalSearch query error:', e);
    }
    return items;
  }, [q, filter, dateFrom, dateTo, amountMin, amountMax, weightMin, weightMax, productStatus]);

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
      <div className="relative animate-fade-in" style={{ width: 640, background: '#FFFFFF', border: '1px solid #E5E1D6', borderRadius: 12, overflow: 'hidden' }}>
        <div className="flex items-center gap-3" style={{ padding: '16px 20px', borderBottom: '1px solid #E5E1D6' }}>
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
              border: '1px solid ' + (showAdvanced || hasFilters ? '#0F0F10' : '#D5D1C4'),
              background: showAdvanced || hasFilters ? '#0F0F10' : 'transparent',
              color: showAdvanced || hasFilters ? '#FFFFFF' : '#6B7280',
            }}
          >Filters</button>
          <span style={{ fontSize: 11, color: '#6B7280', padding: '2px 6px', border: '1px solid #D5D1C4', borderRadius: 4 }}>ESC</span>
        </div>

        <div className="flex items-center gap-2" style={{ padding: '10px 20px', borderBottom: '1px solid #E5E1D6', flexWrap: 'wrap' }}>
          {FILTER_CHIPS.map(chip => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                border: '1px solid ' + (filter === chip.key ? '#0F0F10' : '#D5D1C4'),
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
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #E5E1D6', background: '#F7F5EE', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Date from</span>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D1C4', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Date to</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D1C4', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}><CircleDollarSign size={11} style={{ display: 'inline', marginRight: 3 }} />Min amount (BHD)</span>
              <input type="number" step="0.001" value={amountMin} onChange={e => setAmountMin(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D1C4', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}><CircleDollarSign size={11} style={{ display: 'inline', marginRight: 3 }} />Max amount (BHD)</span>
              <input type="number" step="0.001" value={amountMax} onChange={e => setAmountMax(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D1C4', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Min weight (g)</span>
              <input type="number" step="0.01" value={weightMin} onChange={e => setWeightMin(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D1C4', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#6B7280' }}>Max weight (g)</span>
              <input type="number" step="0.01" value={weightMax} onChange={e => setWeightMax(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D1C4', borderRadius: 6, fontSize: 12 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: 'span 2' }}>
              <span style={{ color: '#6B7280' }}>Product status</span>
              <select value={productStatus} onChange={e => setProductStatus(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #D5D1C4', borderRadius: 6, fontSize: 12, background: '#FFFFFF' }}>
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
                  onMouseEnter={e => (e.currentTarget.style.background = '#E5E1D6')}
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
